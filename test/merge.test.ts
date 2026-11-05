import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { capture, git, lane, laneWith, locked, makeRepo, root } from './support.ts';

const { cmdSync, cmdVerify } = lane;

test('verify passes one lane in a pool slot and gives the slot back', () => {
  const main = makeRepo('eight');
  laneWith('eight', 'feat-a', 'a.txt', 'a\n');
  const { result, out } = capture(() => cmdVerify('eight', { keep: false }));
  assert.equal(result, 0, out);
  assert.match(out, /checks pass/);
  const slot = path.join(root, 'eight-2');
  assert.equal(locked(main, slot), null, 'verify slot given back');
  assert.equal(git(slot, 'status', '--porcelain'), '');
});

test('verify finds lanes that merge cleanly but break each other', () => {
  const main = makeRepo('nine');
  laneWith('nine', 'feat-a', 'a.txt', 'a\n');
  laneWith('nine', 'feat-b', 'b.txt', 'b\n');
  const { result, out } = capture(() => cmdVerify('nine', { keep: false }));
  assert.equal(result, 1, out);
  assert.match(out, /FAILS/);
  assert.match(locked(main, path.join(root, 'nine-3')) ?? '', /^verify/, 'kept, held, to look at');
});

test('verify reports a text conflict and still checks the rest', () => {
  makeRepo('ten');
  laneWith('ten', 'feat-c', 'base.txt', 'one\nC\n');
  laneWith('ten', 'feat-d', 'base.txt', 'one\nD\n');
  const { result, out } = capture(() => cmdVerify('ten', { keep: false }));
  assert.equal(result, 1, out);
  assert.match(out, /CONFLICT with feat-c: base\.txt/);
});

test('sync rebases a lane onto the moved base and runs its checks', () => {
  const main = makeRepo('eleven');
  const lane = laneWith('eleven', 'feat-e', 'e.txt', 'e\n');
  fs.writeFileSync(path.join(main, 'merged.txt'), 'from another lane\n');
  git(main, 'add', 'merged.txt');
  git(main, 'commit', '-q', '-m', 'another lane merged');
  git(main, 'push', '-q', 'origin', 'main');
  const { result, out } = capture(() => cmdSync('eleven', { push: false }));
  assert.equal(result, 0, out);
  assert.match(out, /rebased, checks pass/);
  assert.equal(fs.existsSync(path.join(lane, 'merged.txt')), true);
  assert.equal(git(lane, 'log', '-1', '--format=%s'), 'add e.txt');
});

test('sync leaves a conflicting lane as it was', () => {
  const main = makeRepo('twelve');
  const lane = laneWith('twelve', 'feat-f', 'base.txt', 'one\nF\n');
  const before = git(lane, 'rev-parse', 'HEAD');
  fs.writeFileSync(path.join(main, 'base.txt'), 'one\nMAIN\n');
  git(main, 'commit', '-q', '-am', 'main changed the same line');
  git(main, 'push', '-q', 'origin', 'main');
  const { result, out } = capture(() => cmdSync('twelve', { push: false }));
  assert.equal(result, 1, out);
  assert.match(out, /CONFLICT, left as it was: base\.txt/);
  assert.equal(git(lane, 'rev-parse', 'HEAD'), before);
  assert.equal(git(lane, 'status', '--porcelain'), '');
});
