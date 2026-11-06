// Merged work found offline, leases, and holds left behind.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { isStale } from '../src/lock-state.ts';
import { mergedInto } from '../src/merged.ts';
import { looksAbandoned, processesUsing } from '../src/stale.ts';
import { capture, git, lane, laneWith, locked, makeRepo, take } from './support.ts';

const { cmdClaim, cmdClean, cmdDone, cmdFree, cmdRelease } = lane;
// after support.ts: it points the settings at the temporary folder first
const { Checkout } = await import('../src/checkout.ts');

/** Squash-merges a lane's branch on origin's main, the way GitHub does, from the main clone. */
function squashOnMain(main: string, branch: string): void {
  git(main, 'merge', '--squash', '-q', branch);
  git(main, 'commit', '-q', '-m', `squash ${branch}`);
  git(main, 'push', '-q', 'origin', 'main');
}

test('mergedInto finds a squash merge, also after the base touched the same lines again', () => {
  const main = makeRepo('m1');
  const a = laneWith('m1', 'feat-a', 'base.txt', 'one\nA\n');
  const start = git(a, 'rev-parse', 'HEAD~1');
  const lane = new Checkout(a);
  assert.equal(mergedInto(lane, 'origin/main', start), false, 'not merged yet');
  squashOnMain(main, 'feat-a');
  git(a, 'fetch', '-q');
  assert.equal(mergedInto(lane, 'origin/main', start), true, 'squash merge');
  fs.writeFileSync(path.join(main, 'base.txt'), 'one\nA changed later\n');
  git(main, 'commit', '-q', '-am', 'later change');
  git(main, 'push', '-q', 'origin', 'main');
  git(a, 'fetch', '-q');
  assert.equal(mergedInto(lane, 'origin/main', start), true, 'found by patch id');
  assert.equal(mergedInto(lane, 'origin/main', git(a, 'rev-parse', 'HEAD')), false, 'no work of its own');
});

test('lane clean finds a squash merge without GitHub, and keeps the lane while it is held', () => {
  const main = makeRepo('m2');
  const a = laneWith('m2', 'feat-a', 'a.txt', 'a\n');
  const fresh = take('m2', 'feat-b');
  squashOnMain(main, 'feat-a');
  const kept = capture(() => cmdClean({ yes: true, force: false })).out;
  assert.match(kept, /keep +m2-1 +\(no PR, work already in origin\/main; still held for feat-a: lane done m2-1, or lane clean --force\)/);
  assert.notEqual(locked(main, a), null, 'a follow-up round may still use it');
  const { out } = capture(() => cmdClean({ yes: true, force: true }));
  assert.match(out, /give back +m2-1 +\(no PR, work already in origin\/main\)/);
  assert.match(out, /keep +m2-2 +\(no PR\)/, 'a lane with no work yet stays');
  assert.equal(locked(main, a), null);
  assert.notEqual(locked(main, fresh), null);
});

test('lane clean --force keeps a merged lane that still has a claim', () => {
  const main = makeRepo('m5');
  const a = laneWith('m5', 'feat-a', 'a.txt', 'a\n');
  squashOnMain(main, 'feat-a');
  const cwd = process.cwd();
  process.chdir(a);
  try {
    capture(() => cmdClaim('emulator', { noWait: true }));
    const { out } = capture(() => cmdClean({ yes: true, force: true }));
    assert.match(out, /keep +m5-1 +\(no PR, work already in origin\/main; in use: emulator\)/);
    assert.notEqual(locked(main, a), null);
  } finally {
    capture(() => cmdRelease('emulator'));
    process.chdir(cwd);
  }
});

test('lane done --lease refuses a slot that moved on to another task', () => {
  const main = makeRepo('m3');
  const a = take('m3', 'feat-a');
  const old = locked(main, a)?.match(/#([0-9a-f]+)$/)?.[1] ?? '';
  capture(() => cmdDone('m3-1', { force: false, lease: old }));
  take('m3', 'feat-b');
  assert.throws(() => cmdDone('m3-1', { force: false, lease: old }), /not held under lease/);
  assert.match(locked(main, a) ?? '', /^feat-b/);
});

test('lane free refuses a hold that is fresh, and frees one with --force when no work is lost', () => {
  const main = makeRepo('m4');
  const a = take('m4', 'feat-a');
  assert.throws(() => cmdFree('m4-1', { yes: true, force: false }), /does not look abandoned/);
  capture(() => cmdFree('m4-1', { yes: true, force: true }));
  assert.equal(locked(main, a), null);
});

test('a claim ends with the lane hold it was made under', () => {
  const lock = { lane: 'r-1', lanePath: '/wt/r-1', lease: 'aaa111', since: Date.now() };
  const rules = { maxAgeMs: 3600_000, laneExists: () => true };
  assert.equal(isStale(lock, { ...rules, currentLease: () => 'aaa111' }), false);
  assert.equal(isStale(lock, { ...rules, currentLease: () => 'bbb222' }), true, 'slot taken for another task');
  assert.equal(isStale(lock, { ...rules, currentLease: () => undefined }), true, 'slot given back');
});

test('looksAbandoned needs an old hold, an unchanged slot and no process', () => {
  const h = 5 * 3600_000;
  assert.ok(looksAbandoned({ heldMs: h, idleMs: h, processes: 0 }));
  assert.ok(!looksAbandoned({ heldMs: h, idleMs: h, processes: 1 }));
  assert.ok(!looksAbandoned({ heldMs: h, idleMs: 60_000, processes: 0 }));
  assert.ok(!looksAbandoned({ heldMs: null, idleMs: h, processes: 0 }));
});

test('processesUsing sees a process naming the folder, not one naming a longer name', async () => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync.native(process.cwd()), '.probe-'));
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)', path.join(dir, 'x.js')], { stdio: 'ignore' });
  try {
    await new Promise((r) => setTimeout(r, 500));
    assert.ok(processesUsing(dir).includes(child.pid ?? -1));
    assert.ok(!processesUsing(`${dir}0`).includes(child.pid ?? -1));
  } finally {
    child.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
