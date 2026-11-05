import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { isInside, samePath } from '../src/fsutil.ts';
import { IDLE_FREE_MS, pickSlot, type SlotInfo } from '../src/pool.ts';
import { age, lockReason, parseReason, parseWorktrees, slotNumber, unquote, workSafe } from '../src/worktrees.ts';

test('parseWorktrees reads branches, detached heads and lock reasons, quoted or not', () => {
  const text = [
    'worktree F:/ai-agent/junto', 'HEAD abc', 'branch refs/heads/main', '',
    'worktree F:/wt/junto-1', 'HEAD def', 'branch refs/heads/feat/x', 'locked feat/x @ 2026-11-05 16:02Z', '',
    'worktree F:/wt/junto-2', 'HEAD 123', 'detached', 'locked', '',
    'worktree F:/wt/junto-3', 'HEAD 456', 'detached', 'locked "t \\302\\267 x"', '',
  ].join('\n');
  const [main, one, two, three] = parseWorktrees(text);
  assert.equal(main?.locked, null);
  assert.equal(one?.branch, 'feat/x');
  assert.equal(one?.locked, 'feat/x @ 2026-11-05 16:02Z');
  assert.equal(two?.branch, '');
  assert.equal(two?.locked, '');
  assert.equal(three?.locked, 't \u00b7 x');
});

test('unquote undoes git C quoting and leaves plain text alone', () => {
  assert.equal(unquote('"a\\tb \\"c\\" \\\\"'), 'a\tb "c" \\');
  assert.equal(unquote('plain'), 'plain');
});

test('slot names and lock reasons round-trip', () => {
  assert.equal(slotNumber('repokeeper-2', 'repokeeper'), 2);
  assert.equal(slotNumber('repokeeper-demo-go-1', 'repokeeper-demo-go'), 1);
  assert.equal(slotNumber('repokeeper-feat-x', 'repokeeper'), null);
  assert.equal(slotNumber('other-1', 'repokeeper'), null);
  const reason = lockReason('feat/x', new Date('2026-11-05T16:02:30Z'));
  assert.equal(reason, 'feat/x @ 2026-11-05 16:02Z');
  assert.deepEqual(parseReason(reason), { task: 'feat/x', since: Date.parse('2026-11-05T16:02:00Z') });
  assert.deepEqual(parseReason('someone else'), { task: 'someone else', since: null });
});

test('workSafe needs a clean tree and pushed (or squash-merged) commits', () => {
  assert.ok(workSafe({ dirty: 0, unpushed: false, mergedHere: false }));
  assert.ok(workSafe({ dirty: 0, unpushed: true, mergedHere: true }));
  assert.ok(!workSafe({ dirty: 0, unpushed: true, mergedHere: false }));
  assert.ok(!workSafe({ dirty: 1, unpushed: false, mergedHere: true }));
});

const slot = (n: number, s: Partial<SlotInfo> = {}): SlotInfo => ({ n, locked: null, dirty: 0, released: true, idleMs: 0, ...s });

test('pickSlot: the held slot, the old one, the lowest free, a new one, or full', () => {
  const busy = slot(1, { locked: 'other @ 2026-11-05 10:00Z' });
  assert.deepEqual(pickSlot([slot(1, { locked: 'mine @ 2026-11-05 10:00Z' })], 'mine', 4), { kind: 'held', n: 1 });
  assert.deepEqual(pickSlot([busy, slot(2), slot(3, { lastTask: 'mine' })], 'mine', 4), { kind: 'reuse', n: 3 });
  assert.deepEqual(pickSlot([busy, slot(3), slot(2)], 'mine', 4), { kind: 'reuse', n: 2 });
  assert.deepEqual(pickSlot([busy, slot(3, { locked: 'x' })], 'mine', 4), { kind: 'create', n: 2 });
  assert.deepEqual(pickSlot([busy, slot(2, { locked: 'y' })], 'mine', 2), { kind: 'full' });
});

test('pickSlot frees a slot nobody gave back only when clean and idle for two hours', () => {
  const kept = slot(1, { released: false, idleMs: IDLE_FREE_MS - 1 });
  assert.deepEqual(pickSlot([kept], 't', 4), { kind: 'create', n: 2 });
  assert.deepEqual(pickSlot([{ ...kept, idleMs: IDLE_FREE_MS }], 't', 4), { kind: 'reuse', n: 1 });
  assert.deepEqual(pickSlot([slot(1, { dirty: 1 })], 't', 4), { kind: 'create', n: 2 });
});

test('age reads in minutes, hours or days', () => {
  assert.equal(age(5 * 60_000), '5 min');
  assert.equal(age(3 * 3600_000), '3 h');
  assert.equal(age(3 * 86_400_000), '3 d');
});

test('path helpers compare whole folder names', () => {
  const root = path.resolve('wt');
  assert.ok(samePath(path.join(root, 'a'), path.join(root, 'a') + path.sep));
  assert.ok(isInside(path.join(root, 'junto-x'), root));
  assert.ok(!isInside(path.resolve('wtx', 'a'), root));
});

test('path helpers ignore case and slash style (Windows)', { skip: process.platform !== 'win32' }, () => {
  assert.ok(samePath('F:/wt/a', 'f:\\WT\\a\\'));
  assert.ok(isInside('F:/wt/junto-x', 'F:\\wt'));
});
