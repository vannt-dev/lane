// lane with calmrun installed: a fake calmrun on PATH logs what it is asked and runs the command.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { capture, git, lane, makeRepo, take } from './support.ts';
import { findOnPath } from '../src/calmrun.ts';
import { Locks } from '../src/locks.ts';
import { readStats } from '../src/stats.ts';

const { cmdClaim, cmdDone, cmdRelease } = lane;
const tmp = (prefix = 'lane-calmrun-') => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const quiet = { say: () => {}, pollMs: 50, tellMs: 60_000, minFreeBytes: 0 };

// The fake: --version, hold --help (0.3.0 and newer, or a build with hold.txt), hold, hold --renew,
// release, and running a job: the command after `--` runs with CALMRUN_HELD set, like calmrun's own
// children; the CALMRUN_LEASE a job gets is noted in <log>.lease.
const FAKE = `import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const argv = process.argv.slice(2);
const here = path.dirname(fileURLToPath(import.meta.url));
const version = fs.readFileSync(path.join(here, 'version.txt'), 'utf8').trim();
if (process.env.FAKE_CALMRUN_LOG) fs.appendFileSync(process.env.FAKE_CALMRUN_LOG, JSON.stringify(argv) + '\\n');
const [major, minor] = version.split('.').map(Number);
if (argv[0] === '--version') { console.log('calmrun ' + version); process.exit(0); }
if (argv[0] === 'hold' && argv[1] === '--help') {
  if (major > 0 || minor >= 3 || fs.existsSync(path.join(here, 'hold.txt'))) {
    console.log('Usage: calmrun hold [--ttl <SECS>] [--label <L>] [--for <DIR>] [--renew <LEASE>] [RESOURCE]...'); process.exit(0);
  }
  console.error('calmrun: cannot run hold: command not found: hold'); process.exit(127);
}
if (argv[0] === 'hold' && argv[1] === '--renew') process.exit(Number(process.env.FAKE_CALMRUN_RENEW_EXIT || 0));
if (argv[0] === 'hold') {
  // what the claim's lock looks like while the hold waits
  const lock = process.env.FAKE_CALMRUN_LOCK;
  if (lock) fs.writeFileSync(process.env.FAKE_CALMRUN_LOG + '.lock', fs.readFileSync(lock, 'utf8'));
  const code = Number(process.env.FAKE_CALMRUN_HOLD_EXIT || 0);
  if (code) process.exit(code);
  console.log('lease-' + process.pid); process.exit(0);
}
if (argv[0] === 'release') process.exit(0);
if (process.env.CALMRUN_LEASE) fs.appendFileSync(process.env.FAKE_CALMRUN_LOG + '.lease', process.env.CALMRUN_LEASE + '\\n');
if (process.env.FAKE_CALMRUN_EXIT) process.exit(Number(process.env.FAKE_CALMRUN_EXIT));
const cmd = argv.slice(argv.indexOf('--') + 1);
const env = { ...process.env, CALMRUN_HELD: String(process.pid) };
const r = cmd.length === 1 ? spawnSync(cmd[0], { shell: true, stdio: 'inherit', env })
  : spawnSync(cmd[0], cmd.slice(1), { stdio: 'inherit', env });
process.exit(r.status ?? 1);
`;

/** A folder holding a fake calmrun of this version: calmrun.cmd on Windows, a shell script elsewhere. */
function fakeCalmrun(version: string, hold = false): string {
  const dir = tmp('fake-calmrun-');
  if (hold) fs.writeFileSync(path.join(dir, 'hold.txt'), '');
  fs.writeFileSync(path.join(dir, 'fake.mjs'), FAKE);
  fs.writeFileSync(path.join(dir, 'version.txt'), version);
  if (process.platform === 'win32') {
    fs.writeFileSync(path.join(dir, 'calmrun.cmd'), `@"${process.execPath}" "%~dp0fake.mjs" %*\r\n`);
  } else {
    fs.writeFileSync(path.join(dir, 'calmrun'), `#!/bin/sh\nexec "${process.execPath}" "\${0%/*}/fake.mjs" "$@"\n`, { mode: 0o755 });
  }
  return dir;
}

const fakes = {
  new: fakeCalmrun('0.3.0'),
  /** calmrun built from main between releases: still 0.2.0, with hold. */
  main: fakeCalmrun('0.2.0', true),
  old: fakeCalmrun('0.2.0'),
  tooOld: fakeCalmrun('0.1.4'),
};

/** git's folder: the claim tests need git, and nothing else from PATH. */
const gitDir = path.dirname(findOnPath('git') ?? 'git');

/**
 * Runs `fn` with only `binDir` and git on PATH (so a calmrun installed here is never found),
 * calmrun turned on and a fresh log; returns what the fake was asked.
 */
function withFake<T>(binDir: string, fn: () => T, extra: Record<string, string | undefined> = {}):
  { result: T; calls: string[][]; leases: string[] } {
  const vars: Record<string, string | undefined> = {
    PATH: [binDir, gitDir].join(path.delimiter), LANE_CALMRUN: undefined, FAKE_CALMRUN_LOG: path.join(tmp(), 'calls.jsonl'), ...extra,
  };
  const log = vars.FAKE_CALMRUN_LOG!;
  const old = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    const result = fn();
    const calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as string[]) : [];
    const leases = fs.existsSync(`${log}.lease`) ? fs.readFileSync(`${log}.lease`, 'utf8').trim().split('\n') : [];
    return { result, calls, leases };
  } finally {
    for (const [k, v] of Object.entries(old)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const jobs = (calls: string[][]) => calls.filter((c) => c.includes('--') && c[0] !== 'hold');
/** argv for node running `code` with the marker file as process.argv[1]. */
const nodeCmd = (code: string, marker: string) => [process.execPath, '-e', code, marker];

test('lane with build hands the command to calmrun with its label, cost, priority and wait', () => {
  const root = tmp();
  const marker = path.join(root, 'held.txt');
  const cmd = nodeCmd("require('fs').writeFileSync(process.argv[1], process.env.CALMRUN_HELD || '')", marker);
  const { result, calls } = withFake(fakes.new, () => new Locks(root).withSlot('build', 4, { lane: 'r-1' }, cmd, {
    ...quiet, cost: 3, prio: 'high', label: 'unit', waitTimeoutS: 30, ticket: 17,
  }));
  assert.equal(result, 0);
  assert.deepEqual(jobs(calls), [[
    '--ticket', '17', '--label', 'r-1:unit', '--cost', '3', '--prio', 'high', '--wait-timeout', '30', '--', ...cmd,
  ]]);
  assert.match(fs.readFileSync(marker, 'utf8'), /^\d+$/, 'the command ran inside calmrun');
  assert.deepEqual(new Locks(root).list(), [], 'no lane slots taken');
  assert.deepEqual(readStats(root), [], 'the run is in calmrun stats, not lane stats');
});

test('without --cost and --label calmrun weighs the command; the label is the lane and the kind', () => {
  const { calls } = withFake(fakes.new, () => new Locks(tmp()).withSlot('build', 4, { lane: 'r-2' }, [process.execPath, '-e', ''], {
    ...quiet, kind: 'vitest',
  }));
  assert.deepEqual(jobs(calls), [['--label', 'r-2:vitest', '--', process.execPath, '-e', '']]);
});

test('exit codes pass through calmrun, also 75 when its wait ran out, and a command line given as one string', () => {
  const root = tmp();
  const exit3 = withFake(fakes.new, () => new Locks(root).withSlot('build', 2, { lane: 'a' }, [process.execPath, '-e', 'process.exit(3)'], quiet));
  assert.equal(exit3.result, 3);
  const line = withFake(fakes.new, () => new Locks(root).withSlot('build', 2, { lane: 'a' },
    [`"${process.execPath}" -e "process.exit(4)"`], quiet));
  assert.equal(line.result, 4, 'the one-string command survives the shim and runs in the shell');
  assert.deepEqual(jobs(line.calls)[0]?.slice(-1), [`"${process.execPath}" -e "process.exit(4)"`]);
  const timedOut = withFake(fakes.new, () => new Locks(root).withSlot('build', 2, { lane: 'a' }, [process.execPath, '-e', ''], {
    ...quiet, waitTimeoutS: 5,
  }), { FAKE_CALMRUN_EXIT: '75' });
  assert.equal(timedOut.result, 75);
});

test('another resource is taken in lane first, then calmrun runs the command with --needs', () => {
  const root = tmp();
  const marker = path.join(root, 'seen.txt');
  const cmd = nodeCmd(`require('fs').writeFileSync(process.argv[1], String(require('fs').existsSync(${JSON.stringify(path.join(root, '.locks', 'emulator.json'))})))`, marker);
  const { result, calls } = withFake(fakes.new, () => new Locks(root).withSlot('emulator', 1, { lane: 'r-1' }, cmd, { ...quiet, label: 'e2e' }));
  assert.equal(result, 0);
  assert.deepEqual(jobs(calls), [['--label', 'r-1:e2e', '--needs', 'emulator', '--', ...cmd]]);
  assert.equal(fs.readFileSync(marker, 'utf8'), 'true', "lane's lock is held while calmrun runs it");
  assert.deepEqual(new Locks(root).list(), []);
});

test("lane's own line runs the command when calmrun is missing, too old or turned off", () => {
  const cases: [string, Record<string, string | undefined>][] = [
    [tmp('no-calmrun-'), {}],
    [fakes.tooOld, {}],
    [fakes.new, { LANE_CALMRUN: '0' }],
  ];
  for (const [dir, extra] of cases) {
    const root = tmp();
    const { result, calls } = withFake(dir, () => new Locks(root).withSlot('build', 2, { lane: 'a' }, [process.execPath, '-e', 'process.exit(5)'], quiet), extra);
    assert.equal(result, 5);
    assert.deepEqual(jobs(calls), [], `no calmrun job (${path.basename(dir)} ${JSON.stringify(extra)})`);
    assert.equal(readStats(root).length, 1, "a run of lane's own line is in lane stats");
  }
});

test('inside a calmrun job a lane with build runs at once, without a second queue', () => {
  const outer = spawnSync(process.execPath, ['-e',
    "const c = require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], { detached: true, stdio: 'ignore' }); c.unref(); console.log(c.pid);",
  ], { encoding: 'utf8' });
  const pid = outer.stdout.trim();
  const root = tmp();
  const { result, calls } = withFake(fakes.new, () => new Locks(root).withSlot('build', 1, { lane: 'a' }, [process.execPath, '-e', 'process.exit(6)'], quiet),
    { CALMRUN_HELD: pid });
  assert.equal(result, 6);
  assert.deepEqual(jobs(calls), []);
  assert.deepEqual(readStats(root), [], 'not counted twice');
  try {
    process.kill(Number(pid));
  } catch {
    // ended already
  }
});

test("lane's own line gives up after --wait-timeout with exit 75", () => {
  const root = tmp();
  const locks = new Locks(root);
  locks.tryTake('build', { lane: 'busy', pid: process.pid });
  assert.equal(locks.withSlot('build', 1, { lane: 'a' }, [process.execPath, '-e', ''], { ...quiet, waitTimeoutS: 0 }), 75);
});

/**
 * Runs `fn` inside a new lane of a new repository; the emulator claim, if left, goes after (the
 * tests share one lane root: a claim left by a failed test would hold up the next).
 */
function inLane<T>(repo: string, fn: (dir: string) => T): T {
  makeRepo(repo);
  const dir = take(repo, 'feat-x');
  const cwd = process.cwd();
  process.chdir(dir);
  try {
    return fn(dir);
  } finally {
    process.chdir(cwd);
    fs.rmSync(path.join(lane.config.root, '.locks', 'emulator.json'), { force: true });
  }
}

const claimLock = (name: string) => new Locks(lane.config.root).read(name);

test('a claim takes a calmrun lease for the lane folder, its own commands use it, lane release gives it back', () => {
  inLane('cr1', (dir) => {
    const top = git(dir, 'rev-parse', '--show-toplevel');
    const claimed = withFake(fakes.new, () => capture(() => cmdClaim('emulator', { noWait: false })).out);
    assert.match(claimed.result, /emulator is yours \(cr1-1\), in calmrun too \(lease lease-\d+\)/);
    const hold = claimed.calls.find((c) => c[0] === 'hold' && c[1] !== '--help');
    assert.deepEqual(hold, ['hold', 'emulator', '--for', path.resolve(top), '--ttl', '10800', '--label', 'cr1-1:claim']);
    const lease = claimLock('emulator')?.calmrunLease;
    assert.match(lease ?? '', /^lease-\d+$/);
    const locks = new Locks(lane.config.root);
    const me = { lane: 'cr1-1', lanePath: top };
    const build = withFake(fakes.new, () => locks.withSlot('build', 2, me, [process.execPath, '-e', ''], { ...quiet, label: 'b' }));
    assert.equal(build.result, 0);
    assert.deepEqual(jobs(build.calls), [['--label', 'cr1-1:b', '--', process.execPath, '-e', '']], 'it goes to calmrun');
    assert.deepEqual(build.leases, [lease], 'with the lease, so calmrun does not hold it behind that lease');
    const emu = withFake(fakes.new, () => locks.withSlot('emulator', 1, me, [process.execPath, '-e', ''], { ...quiet, label: 'e', waitTimeoutS: 0 }));
    assert.equal(emu.result, 0, 'the claiming lane does not wait for its own claim');
    assert.deepEqual(jobs(emu.calls), [['--label', 'cr1-1:e', '--needs', 'emulator', '--wait-timeout', '0', '--', process.execPath, '-e', '']]);
    assert.deepEqual(emu.leases, [lease]);
    const other = withFake(fakes.new, () => locks.withSlot('emulator', 1, { lane: 'cr1-9', lanePath: path.join(top, '..', 'cr1-9') },
      [process.execPath, '-e', ''], { ...quiet, waitTimeoutS: 0 }));
    assert.equal(other.result, 75, 'another lane waits for the claim');
    assert.deepEqual(jobs(other.calls), []);
    const released = withFake(fakes.new, () => capture(() => cmdRelease('emulator')));
    assert.deepEqual(released.calls.filter((c) => c[0] === 'release'), [['release', lease]]);
    assert.equal(claimLock('emulator'), null);
  });
});

test('lane done gives the lease of a claim back', () => {
  inLane('cr2', () => {
    withFake(fakes.new, () => capture(() => cmdClaim('emulator', { noWait: false })));
    const lease = claimLock('emulator')?.calmrunLease;
    const done = withFake(fakes.new, () => capture(() => cmdDone(undefined, { force: true })));
    assert.deepEqual(done.calls.filter((c) => c[0] === 'release'), [['release', lease]]);
    assert.equal(claimLock('emulator'), null);
  });
});

test('a calmrun without hold: the claim is lane-only, with a note, and only hold --help is asked', () => {
  inLane('cr3', () => {
    const { result, calls } = withFake(fakes.old, () => capture(() => cmdClaim('emulator', { noWait: false })).out);
    assert.match(result, /calmrun 0\.2\.0 has no hold/);
    assert.match(result, /emulator is yours \(cr3-1\)\. Free it/);
    assert.deepEqual(calls.filter((c) => c[0] === 'hold'), [['hold', '--help']], 'only asked whether it has hold');
    assert.equal(claimLock('emulator')?.calmrunLease, undefined);
    withFake(fakes.old, () => capture(() => cmdRelease('emulator')));
  });
});

test('claim --no-wait fails, and frees the lane lock, when a calmrun job holds the resource', () => {
  inLane('cr4', () => {
    const { calls } = withFake(fakes.new, () => assert.throws(() => capture(() => cmdClaim('emulator', { noWait: true })), /in use by a calmrun job/),
      { FAKE_CALMRUN_HOLD_EXIT: '75' });
    assert.deepEqual(calls.find((c) => c[0] === 'hold' && c[1] !== '--help')?.slice(-2), ['--wait-timeout', '0']);
    assert.equal(claimLock('emulator'), null);
  });
});

test('claiming again renews the lease, and holds anew when calmrun no longer has it', () => {
  inLane('cr6', () => {
    withFake(fakes.new, () => capture(() => cmdClaim('emulator', { noWait: false })));
    const first = claimLock('emulator')!;
    const again = withFake(fakes.new, () => capture(() => cmdClaim('emulator', { noWait: true })).out);
    assert.match(again.result, /emulator is yours already \(cr6-1\); claim and calmrun lease lease-\d+ renewed/);
    assert.deepEqual(again.calls.filter((c) => c[0] === 'hold' && c[1] !== '--help'), [['hold', '--renew', first.calmrunLease!, '--ttl', '10800']]);
    assert.equal(claimLock('emulator')?.calmrunLease, first.calmrunLease);
    assert.ok(claimLock('emulator')!.since >= first.since, 'the claim starts again');
    const gone = withFake(fakes.new, () => capture(() => cmdClaim('emulator', { noWait: false })).out, { FAKE_CALMRUN_RENEW_EXIT: '1' });
    const holds = gone.calls.filter((c) => c[0] === 'hold' && c[1] !== '--help');
    assert.equal(holds.length, 2);
    assert.equal(holds[1]?.[1], 'emulator', 'a new hold after the renew failed');
    assert.notEqual(claimLock('emulator')?.calmrunLease, first.calmrunLease);
    withFake(fakes.new, () => capture(() => cmdRelease('emulator')));
  });
});

test('a calmrun built between releases (0.2.0 with hold --help) takes leases', () => {
  inLane('cr7', () => {
    const { result, calls } = withFake(fakes.main, () => capture(() => cmdClaim('emulator', { noWait: false })).out);
    assert.match(result, /in calmrun too \(lease lease-\d+\)/);
    assert.deepEqual(calls.filter((c) => c[0] === 'hold').map((c) => c[1]), ['--help', 'emulator']);
    withFake(fakes.main, () => capture(() => cmdRelease('emulator')));
  });
});

test('while calmrun hold waits the claim lives with the lane process; a failed hold leaves a lane-only claim', () => {
  inLane('cr5', () => {
    const log = path.join(tmp(), 'calls.jsonl');
    const lockFile = path.join(lane.config.root, '.locks', 'emulator.json');
    const { result } = withFake(fakes.new, () => capture(() => cmdClaim('emulator', { noWait: false })).out,
      { FAKE_CALMRUN_LOG: log, FAKE_CALMRUN_LOCK: lockFile, FAKE_CALMRUN_HOLD_EXIT: '3' });
    const during = JSON.parse(fs.readFileSync(`${log}.lock`, 'utf8')) as { pid?: number };
    assert.equal(during.pid, process.pid, 'a lane killed during the hold leaves a stale claim, not a stuck one');
    assert.match(result, /calmrun hold emulator failed \(exit 3\)/);
    const after = claimLock('emulator');
    assert.equal(after?.pid, undefined, 'the claim outlives the command again');
    assert.equal(after?.calmrunLease, undefined);
    withFake(fakes.new, () => capture(() => cmdRelease('emulator')));
  });
});
