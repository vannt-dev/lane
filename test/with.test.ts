import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Locks } from '../src/locks.ts';
import { Queue } from '../src/queue.ts';
import { commandLabel, readStats, summarize } from '../src/stats.ts';
import { withSlotsFor } from '../src/config.ts';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lane-with-'));
const quiet = { say: () => {}, pollMs: 50, tellMs: 60_000 };
/** A command that writes the lock folder's listing (or another value) into a marker file. */
const writeCmd = (marker: string, expr: string) =>
  `node -e "require('fs').writeFileSync(process.argv[1], String(${expr}))" "${marker}"`;
/** A live process for some time: its pid holds locks or queue places in a test. */
function sleeper(ms: number) {
  const child = spawn(process.execPath, ['-e', `setTimeout(() => {}, ${ms})`], { stdio: 'ignore' });
  return child;
}

test('a cost of 2 holds two slots while the command runs, and frees both', () => {
  const root = tmp();
  const locks = new Locks(root);
  const marker = path.join(root, 'seen.txt');
  const cmd = writeCmd(marker, `require('fs').readdirSync(process.argv[2]).filter(f => f.endsWith('.json')).join(',')`) +
    ` "${path.join(root, '.locks')}"`;
  assert.equal(locks.withSlot('build', 3, { lane: 'a' }, [cmd], { ...quiet, cost: 2 }), 0);
  assert.equal(fs.readFileSync(marker, 'utf8'), 'build-1.json,build-2.json');
  assert.deepEqual(locks.list(), []);
});

test('a cost above the slots fails at once instead of waiting forever', () => {
  const locks = new Locks(tmp());
  assert.throws(() => locks.withSlot('build', 2, { lane: 'a' }, ['node -e ""'], { ...quiet, cost: 3 }), /--cost 3.*2 slots/);
});

test('takeSlots is all or nothing: a cost of 2 with one free slot takes none', () => {
  const root = tmp();
  const locks = new Locks(root);
  locks.tryTake('build-1', { lane: 'busy', pid: process.pid });
  assert.equal(locks.takeSlots('build', 2, 2, { lane: 'a', pid: process.pid }), null);
  assert.deepEqual(locks.list().map((l) => l.name), ['build-1']);
  assert.deepEqual(locks.takeSlots('build', 3, 2, { lane: 'a', pid: process.pid }), ['build-2', 'build-3']);
});

test('the queue puts high before normal, then first come first served, and drops the dead', () => {
  const dir = path.join(tmp(), 'q');
  const dead = new Set([3]);
  const q = new Queue(dir, (pid) => !dead.has(pid));
  const a = q.join({ lane: 'a', pid: 1, cost: 1, prio: 'normal', since: 100 });
  const b = q.join({ lane: 'b', pid: 2, cost: 1, prio: 'normal', since: 200 });
  const c = q.join({ lane: 'c', pid: 3, cost: 1, prio: 'high', since: 50 });
  const d = q.join({ lane: 'd', pid: 4, cost: 2, prio: 'high', since: 300 });
  assert.deepEqual(q.line().map((w) => w.id), [d, a, b]);
  assert.equal(fs.readdirSync(dir).some((f) => f.startsWith(c)), false);
  q.leave(d);
  assert.deepEqual(q.line().map((w) => w.id), [a, b]);
});

test('a nested lane with on a resource its caller holds runs at once, without a slot', () => {
  const root = tmp();
  const locks = new Locks(root);
  locks.tryTake('build-1', { lane: 'outer', pid: process.pid });
  locks.tryTake('build-2', { lane: 'outer', pid: process.pid });
  const old = process.env.LANE_WITH;
  process.env.LANE_WITH = `emulator:1,build:${process.pid}`;
  try {
    assert.equal(locks.withSlot('build', 2, { lane: 'a' }, ['node -e "process.exit(4)"'], quiet), 4);
  } finally {
    if (old === undefined) delete process.env.LANE_WITH;
    else process.env.LANE_WITH = old;
  }
  assert.deepEqual(locks.list().map((l) => l.name), ['build-1', 'build-2']);
});

test('the command learns which resources it holds, for nested calls', () => {
  const root = tmp();
  const marker = path.join(root, 'env.txt');
  assert.equal(new Locks(root).withSlot('build', 2, { lane: 'a' }, [writeCmd(marker, 'process.env.LANE_WITH')], quiet), 0);
  assert.equal(fs.readFileSync(marker, 'utf8'), `build:${process.pid}`);
});

test('the command runs below normal CPU priority unless LANE_LOW_CPU=0', () => {
  const root = tmp();
  const marker = path.join(root, 'prio.txt');
  const cmd = writeCmd(marker, `require('os').getPriority()`);
  const locks = new Locks(root);
  assert.equal(locks.withSlot('build', 2, { lane: 'a' }, [cmd], quiet), 0);
  assert.equal(Number(fs.readFileSync(marker, 'utf8')), os.constants.priority.PRIORITY_BELOW_NORMAL);
  process.env.LANE_LOW_CPU = '0';
  try {
    assert.equal(locks.withSlot('build', 2, { lane: 'a' }, [cmd], quiet), 0);
  } finally {
    delete process.env.LANE_LOW_CPU;
  }
  assert.equal(Number(fs.readFileSync(marker, 'utf8')), os.getPriority());
});

test('a waiter says its place in line, skips a dead head, and runs once the slot frees', async () => {
  const root = tmp();
  const locks = new Locks(root);
  const holder = sleeper(1200);
  const head = sleeper(400);
  await new Promise((r) => setTimeout(r, 100));
  locks.tryTake('build', { lane: 'busy', pid: holder.pid });
  new Queue(path.join(root, '.locks', 'queue', 'build')).join({ lane: 'early', pid: head.pid!, cost: 1, prio: 'normal', since: 1 });
  const said: string[] = [];
  const status = locks.withSlot('build', 1, { lane: 'a' }, ['node -e "process.exit(0)"'],
    { say: (m) => said.push(m), pollMs: 50, tellMs: 150 });
  assert.equal(status, 0);
  assert.match(said[0] ?? '', /waiting for build: 1 of 1 slots in use, 2nd in line/);
  assert.ok(said.some((m) => /1st in line/.test(m)), said.join('\n'));
  assert.deepEqual(fs.readdirSync(path.join(root, '.locks', 'queue', 'build')), []);
});

test('each run is logged for lane stats, with a label and never the whole command', () => {
  const root = tmp();
  const locks = new Locks(root);
  locks.withSlot('build', 2, { lane: 'a' }, ['node -e "process.exit(1)" -- --token=secret'], quiet);
  locks.withSlot('build', 2, { lane: 'a' }, ['node -e ""'], { ...quiet, label: 'unit tests', cost: 2 });
  const runs = readStats(root);
  assert.equal(runs.length, 2);
  assert.deepEqual(runs.map((r) => [r.res, r.label, r.cost, r.status]), [['build', 'node', 1, 1], ['build', 'unit tests', 2, 0]]);
  assert.ok(!fs.readFileSync(path.join(root, '.locks', 'stats.log'), 'utf8').includes('secret'));
});

test('commandLabel keeps the tool and its subcommand, not paths or arguments', () => {
  assert.equal(commandLabel(['npx vitest run --reporter=dot']), 'npx vitest');
  assert.equal(commandLabel(['npm run test -- --watch=false']), 'npm run test');
  assert.equal(commandLabel(['C:/tools/flutter/bin/flutter.bat', 'test']), 'flutter test');
  assert.equal(commandLabel(['cargo', 'build', '--release']), 'cargo build');
  assert.equal(commandLabel(['./gradlew assembleDebug']), 'gradlew');
});

test('summarize: runs, failures, waits and run times per label, within the days asked', () => {
  const now = Date.UTC(2026, 10, 20);
  const day = 86_400_000;
  const rows = summarize([
    { at: now - 1000, res: 'build', label: 'tsc', cost: 2, waitMs: 4000, runMs: 10_000, status: 0 },
    { at: now - 2000, res: 'build', label: 'tsc', cost: 2, waitMs: 0, runMs: 20_000, status: 2 },
    { at: now - 3000, res: 'build', label: 'eslint', cost: 1, waitMs: 1000, runMs: 5000, status: 0 },
    { at: now - 10 * day, res: 'build', label: 'old', cost: 1, waitMs: 0, runMs: 1, status: 0 },
  ], { days: 3, now });
  assert.deepEqual(rows, [
    { res: 'build', label: 'tsc', runs: 2, failed: 1, avgWaitMs: 2000, maxWaitMs: 4000, avgRunMs: 15_000 },
    { res: 'build', label: 'eslint', runs: 1, failed: 0, avgWaitMs: 1000, maxWaitMs: 1000, avgRunMs: 5000 },
  ]);
});

test('LANE_WITH_SLOTS sets the slots of a resource; build has 2 and others 1 without it', () => {
  const old = process.env.LANE_WITH_SLOTS;
  try {
    delete process.env.LANE_WITH_SLOTS;
    assert.equal(withSlotsFor('build'), 2);
    assert.equal(withSlotsFor('gpu'), 1);
    process.env.LANE_WITH_SLOTS = 'build=6, gpu=2, bad=x';
    assert.equal(withSlotsFor('build'), 6);
    assert.equal(withSlotsFor('gpu'), 2);
    assert.equal(withSlotsFor('bad'), 1);
  } finally {
    if (old === undefined) delete process.env.LANE_WITH_SLOTS;
    else process.env.LANE_WITH_SLOTS = old;
  }
});

test('lane with from the command line: waits in line (shown by lane locks), runs, then shows in lane stats', async () => {
  const root = tmp();
  const bin = path.resolve('bin/lane.ts');
  const env: NodeJS.ProcessEnv = { ...process.env, LANE_ROOT: root, LANE_REPOS: root, LANE_WITH_SLOTS: 'build=1' };
  delete env.LANE_WITH;
  const holder = sleeper(1500);
  await new Promise((r) => setTimeout(r, 100));
  new Locks(root).tryTake('build', { lane: 'busy', pid: holder.pid });
  const waiter = spawn(process.execPath, [bin, 'with', 'build', '--label', 'demo', '--', 'node', '-e', 'process.exit(0)'],
    { env, encoding: 'utf8' } as never);
  let out = '';
  waiter.stdout!.on('data', (d) => { out += String(d); });
  await new Promise((r) => setTimeout(r, 700));
  const shown = spawnSync(process.execPath, [bin, 'locks'], { env, encoding: 'utf8' });
  assert.match(shown.stdout, /waiting for[\s\S]*build\s+1\s/);
  const code = await new Promise((r) => waiter.on('exit', r));
  assert.equal(code, 0);
  assert.match(out, /waiting for build: 1 of 1 slots in use, 1st in line/);
  const stats = spawnSync(process.execPath, [bin, 'stats'], { env, encoding: 'utf8' });
  assert.match(stats.stdout, /build\s+demo\s+1\s+0/);
});
