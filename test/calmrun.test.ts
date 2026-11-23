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

// The fake: --version, hold --help (0.3.0 and newer), hold, release, and running a job: the
// command after `--` runs with CALMRUN_HELD set, like calmrun's own children.
const FAKE = `import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const argv = process.argv.slice(2);
const version = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'version.txt'), 'utf8').trim();
if (process.env.FAKE_CALMRUN_LOG) fs.appendFileSync(process.env.FAKE_CALMRUN_LOG, JSON.stringify(argv) + '\\n');
const [major, minor] = version.split('.').map(Number);
if (argv[0] === '--version') { console.log('calmrun ' + version); process.exit(0); }
if (argv[0] === 'hold' && argv[1] === '--help') {
  if (major > 0 || minor >= 3) { console.log('Usage: calmrun hold <RESOURCES> [--ttl <SECS>] [--label <L>]'); process.exit(0); }
  console.error('calmrun: cannot run hold: command not found: hold'); process.exit(127);
}
if (argv[0] === 'hold') {
  const code = Number(process.env.FAKE_CALMRUN_HOLD_EXIT || 0);
  if (code) process.exit(code);
  console.log('lease-' + process.pid); process.exit(0);
}
if (argv[0] === 'release') process.exit(0);
if (process.env.FAKE_CALMRUN_EXIT) process.exit(Number(process.env.FAKE_CALMRUN_EXIT));
const cmd = argv.slice(argv.indexOf('--') + 1);
const env = { ...process.env, CALMRUN_HELD: String(process.pid) };
const r = cmd.length === 1 ? spawnSync(cmd[0], { shell: true, stdio: 'inherit', env })
  : spawnSync(cmd[0], cmd.slice(1), { stdio: 'inherit', env });
process.exit(r.status ?? 1);
`;

/** A folder holding a fake calmrun of this version: calmrun.cmd on Windows, a shell script elsewhere. */
function fakeCalmrun(version: string): string {
  const dir = tmp('fake-calmrun-');
  fs.writeFileSync(path.join(dir, 'fake.mjs'), FAKE);
  fs.writeFileSync(path.join(dir, 'version.txt'), version);
  if (process.platform === 'win32') {
    fs.writeFileSync(path.join(dir, 'calmrun.cmd'), `@"${process.execPath}" "%~dp0fake.mjs" %*\r\n`);
  } else {
    fs.writeFileSync(path.join(dir, 'calmrun'), `#!/bin/sh\nexec "${process.execPath}" "\${0%/*}/fake.mjs" "$@"\n`, { mode: 0o755 });
  }
  return dir;
}

const fakes = { new: fakeCalmrun('0.3.0'), old: fakeCalmrun('0.2.0'), tooOld: fakeCalmrun('0.1.4') };

/** git's folder: the claim tests need git, and nothing else from PATH. */
const gitDir = path.dirname(findOnPath('git') ?? 'git');

/**
 * Runs `fn` with only `binDir` and git on PATH (so a calmrun installed here is never found),
 * calmrun turned on and a fresh log; returns what the fake was asked.
 */
function withFake<T>(binDir: string, fn: () => T, extra: Record<string, string | undefined> = {}): { result: T; calls: string[][] } {
  const log = path.join(tmp(), 'calls.jsonl');
  const vars: Record<string, string | undefined> = { PATH: [binDir, gitDir].join(path.delimiter), LANE_CALMRUN: undefined, FAKE_CALMRUN_LOG: log, ...extra };
  const old = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    const result = fn();
    const calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as string[]) : [];
    return { result, calls };
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
    ...quiet, cost: 3, prio: 'high', label: 'unit', waitTimeoutS: 30,
  }));
  assert.equal(result, 0);
  assert.deepEqual(jobs(calls), [['--label', 'r-1:unit', '--cost', '3', '--prio', 'high', '--wait-timeout', '30', '--', ...cmd]]);
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

/** Runs `fn` inside a new lane of a new repository. */
function inLane<T>(repo: string, fn: (dir: string) => T): T {
  makeRepo(repo);
  const dir = take(repo, 'feat-x');
  const cwd = process.cwd();
  process.chdir(dir);
  try {
    return fn(dir);
  } finally {
    process.chdir(cwd);
  }
}

const claimLock = (name: string) => new Locks(lane.config.root).read(name);

test('a claim takes a calmrun lease, lane release gives it back, and the lane does not queue behind it', () => {
  inLane('cr1', (dir) => {
    const claimed = withFake(fakes.new, () => capture(() => cmdClaim('emulator', { noWait: false })).out);
    assert.match(claimed.result, /emulator is yours \(cr1-1\), in calmrun too \(lease lease-\d+\)/);
    const hold = claimed.calls.find((c) => c[0] === 'hold' && c[1] !== '--help');
    assert.deepEqual(hold, ['hold', 'emulator', '--ttl', '10800', '--label', 'cr1-1:claim']);
    const lease = claimLock('emulator')?.calmrunLease;
    assert.match(lease ?? '', /^lease-\d+$/);
    const said: string[] = [];
    const own = withFake(fakes.new, () => new Locks(lane.config.root).withSlot('build', 2, { lane: 'cr1-1', lanePath: git(dir, 'rev-parse', '--show-toplevel') },
      [process.execPath, '-e', ''], { ...quiet, say: (m) => said.push(m) }));
    assert.equal(own.result, 0);
    assert.deepEqual(jobs(own.calls), [], "this lane's commands do not wait for its own lease");
    assert.match(said.join('\n'), /holds emulator in calmrun too/);
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

test('a calmrun without hold: the claim is lane-only, with a note, and hold is never called', () => {
  inLane('cr3', () => {
    const { result, calls } = withFake(fakes.old, () => capture(() => cmdClaim('emulator', { noWait: false })).out);
    assert.match(result, /calmrun 0\.2\.0 has no hold/);
    assert.match(result, /emulator is yours \(cr3-1\)\. Free it/);
    assert.deepEqual(calls.filter((c) => c[0] === 'hold'), []);
    assert.equal(claimLock('emulator')?.calmrunLease, undefined);
    withFake(fakes.old, () => capture(() => cmdRelease('emulator')));
  });
});

test('claim --no-wait fails, and frees the lane lock, when a calmrun job holds the resource', () => {
  inLane('cr4', () => {
    const { calls } = withFake(fakes.new, () => assert.throws(() => capture(() => cmdClaim('emulator', { noWait: true })), /in use by a calmrun job/),
      { FAKE_CALMRUN_HOLD_EXIT: '75' });
    assert.deepEqual(calls.find((c) => c[0] === 'hold' && c[1] !== '--help')?.slice(-2), ['--wait-timeout', '1']);
    assert.equal(claimLock('emulator'), null);
  });
});
