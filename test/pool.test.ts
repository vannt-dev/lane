import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { capture, git, lane, laneWith, locked, makeRepo, repos, take } from './support.ts';

const { cmdDone, cmdNew, cmdPort, cmdRemove } = lane;

test('lane new takes numbered slots, each locked with its task', () => {
  const main = makeRepo('one');
  const a = take('one', 'feat-a');
  const b = take('one', 'feat-b');
  assert.equal(path.basename(a), 'one-1');
  assert.equal(path.basename(b), 'one-2');
  assert.match(locked(main, a) ?? '', /^feat-a @ \d{4}-\d{2}-\d{2} \d{2}:\d{2}Z #[0-9a-f]{6}$/);
  assert.equal(git(a, 'branch', '--show-current'), 'feat-a');
  assert.throws(() => cmdNew('one', 'feat-a', { branch: 'other', install: false, open: false }), /feat-a already holds one-1/);
  assert.throws(() => cmdNew('one', 'feat-a', { install: false, open: false }), /feat-a already holds one-1: work there/);
});

test('a slot given back is reused, keeping its ignored caches, and the task gets its old slot', () => {
  const main = makeRepo('two');
  const a = laneWith('two', 'feat-a', 'a.txt', 'a\n');
  fs.mkdirSync(path.join(a, 'cache'));
  fs.writeFileSync(path.join(a, 'cache', 'built.bin'), 'expensive');
  git(a, 'push', '-q', 'origin', 'feat-a');
  const b = laneWith('two', 'feat-b', 'b.txt', 'b\n');
  git(b, 'push', '-q', 'origin', 'feat-b');
  capture(() => cmdDone('two-1', { force: false }));
  capture(() => cmdDone('two-2', { force: false }));
  assert.equal(locked(main, a), null, 'unlocked');
  assert.equal(git(main, 'branch', '--list', 'feat-a'), '', 'pushed branch deleted locally');

  // feat-b had slot 2: it gets slot 2 back, not the lowest free one
  const again = capture(() => cmdNew('two', 'feat-b', { branch: 'feat-b2', install: false, open: false })).result;
  assert.equal(path.basename(again), 'two-2');
  const next = take('two', 'feat-c');
  assert.equal(path.basename(next), 'two-1');
  assert.equal(fs.readFileSync(path.join(next, 'cache', 'built.bin'), 'utf8'), 'expensive', 'caches stay');
  assert.equal(git(next, 'branch', '--show-current'), 'feat-c');
  assert.equal(fs.existsSync(path.join(next, 'a.txt')), false, 'on the base branch, not the old task');
});

test('lane done refuses work that is not safe on the remote', () => {
  makeRepo('three');
  const a = laneWith('three', 'feat-a', 'a.txt', 'a\n');
  assert.throws(() => cmdDone('three-1', { force: false }), /commit\(s\) on no remote branch/);
  fs.writeFileSync(path.join(a, 'wip.txt'), 'x');
  assert.throws(() => cmdDone('three-1', { force: true }), /uncommitted/);
  fs.rmSync(path.join(a, 'wip.txt'));
  capture(() => cmdDone('three-1', { force: true }));
  assert.match(git(path.join(repos, 'three'), 'branch', '--list', 'feat-a'), /feat-a/, 'unpushed branch kept');
});

test('a full pool lists the slots and never takes a held one', () => {
  makeRepo('four');
  take('four', 't1');
  take('four', 't2');
  take('four', 't3');
  const { out } = capture(() =>
    assert.throws(() => cmdNew('four', 't4', { install: false, open: false }), /all 3 slots of four are in use/),
  );
  assert.match(out, /four-1 +held: t1/);
});

test('an unlocked slot nobody gave back is not taken while it was active lately', () => {
  const main = makeRepo('five');
  const a = take('five', 'feat-a');
  git(main, 'worktree', 'unlock', a); // e.g. unlocked by hand, someone may still be working there
  const b = take('five', 'feat-b');
  assert.equal(path.basename(b), 'five-2');
});

test('lane rm deletes a slot, but not a held one without --force', () => {
  makeRepo('six');
  const a = take('six', 'feat-a');
  assert.throws(() => cmdRemove('six-1', { force: false }), /is held/);
  capture(() => cmdRemove('six-1', { force: true }));
  assert.equal(fs.existsSync(a), false);
});

test('lane port gives each slot its own range of ports', () => {
  makeRepo('seven');
  take('seven', 'feat-a');
  const b = take('seven', 'feat-b');
  const cwd = process.cwd();
  process.chdir(b);
  try {
    assert.equal(capture(() => cmdPort(5180, 0)).out.trim(), '5200');
    assert.equal(capture(() => cmdPort(5180, 3)).out.trim(), '5203');
  } finally {
    process.chdir(cwd);
  }
  assert.match(fs.readFileSync(path.join(b, 'CLAUDE.local.md'), 'utf8'), /slot 2: its ports are the usual port \+ 20 to \+ 29/);
});

test('a slot given back stays free after lane list looks at it (git status must not touch the index)', () => {
  makeRepo('eight');
  const a = laneWith('eight', 'feat-a', 'a.txt', 'a\n');
  git(a, 'push', '-q', 'origin', 'feat-a');
  capture(() => cmdDone('eight-1', { force: false }));
  // a file whose mtime is the index's own second makes git status refresh and rewrite the index
  fs.writeFileSync(path.join(a, 'base.txt'), fs.readFileSync(path.join(a, 'base.txt')));
  capture(() => lane.cmdList({ local: true }));
  const again = take('eight', 'feat-b');
  assert.equal(path.basename(again), 'eight-1', 'the given-back slot is reused');
});
