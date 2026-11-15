import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { capture, git, lane, laneWith, locked, makeRepo, root } from './support.ts';

const { cmdNew, cmdVerify } = lane;

/** How many extra check runs the search took. */
const runs = (out: string) => out.split('\n').filter((l) => l.startsWith('-- ')).length;

/** A third lane, in another pool: the default pool (3 slots here) keeps room for the verify slot. */
function sideLane(repo: string, task: string, file: string): void {
  const dir = capture(() => cmdNew(repo, task, { install: false, open: false, pool: 'side' })).result;
  fs.writeFileSync(path.join(dir, file), `${file}\n`);
  git(dir, 'add', file);
  git(dir, 'commit', '-q', '-m', `add ${file}`);
}

/** A file committed on the main clone's base and pushed, before any lane starts. */
function onBase(main: string, file: string, content: string): void {
  fs.writeFileSync(path.join(main, file), content);
  git(main, 'add', file);
  git(main, 'commit', '-q', '-m', `add ${file}`);
  git(main, 'push', '-q', 'origin', 'main');
}

test('verify names the two lanes that pass alone and fail together', () => {
  const main = makeRepo('b1');
  laneWith('b1', 'feat-a', 'a.txt', 'a\n');
  laneWith('b1', 'feat-b', 'b.txt', 'b\n');
  const { result, out } = capture(() => cmdVerify('b1', { keep: false }));
  assert.equal(result, 1, out);
  assert.match(out, /b1-1 \(feat-a\) +pass alone/);
  assert.match(out, /b1-2 \(feat-b\) +pass alone/);
  assert.match(out, /b1-1 \+ b1-2 +FAIL together/);
  assert.match(out, /b1-1 \(feat-a\) and b1-2 \(feat-b\) break each other/);
  assert.equal(runs(out), 2, 'each lane alone; the pair is the combined run itself');
  const slot = path.join(root, 'b1-3');
  assert.match(locked(main, slot) ?? '', /^verify/);
  assert.ok(fs.existsSync(path.join(slot, 'a.txt')) && fs.existsSync(path.join(slot, 'b.txt')), 'the combined checkout is back');
  assert.equal(git(slot, 'status', '--porcelain'), '');
});

test('verify finds the one guilty pair among three lanes', () => {
  makeRepo('b2');
  laneWith('b2', 'feat-a', 'a.txt', 'a\n');
  laneWith('b2', 'feat-b', 'b.txt', 'b\n');
  sideLane('b2', 'feat-c', 'c.txt');
  const { result, out } = capture(() => cmdVerify('b2', { keep: false }));
  assert.equal(result, 1, out);
  assert.match(out, /b2-1 \+ b2-2 +FAIL together: "node check\.js"/);
  assert.match(out, /b2-1 \+ b2-3 +pass together/);
  assert.match(out, /b2-2 \+ b2-3 +pass together/);
  assert.match(out, /b2-1 \(feat-a\) and b2-2 \(feat-b\) break each other/);
  assert.doesNotMatch(out, /feat-c\) (and|fails|break)/);
  assert.equal(runs(out), 6, 'three alone, three pairs');
});

test('verify says which lane fails by itself, and does not go on to pairs', () => {
  makeRepo('b3');
  const x = laneWith('b3', 'feat-x', 'a.txt', 'a\n');
  fs.writeFileSync(path.join(x, 'b.txt'), 'b\n');
  git(x, 'add', 'b.txt');
  git(x, 'commit', '-q', '-m', 'add b.txt');
  laneWith('b3', 'feat-y', 'y.txt', 'y\n');
  const { result, out } = capture(() => cmdVerify('b3', { keep: false }));
  assert.equal(result, 1, out);
  assert.match(out, /b3-1 \(feat-x\) +FAIL alone: "node check\.js"/);
  assert.match(out, /b3-2 \(feat-y\) +pass alone/);
  assert.match(out, /b3-1 \(feat-x\) fails by itself\./);
  assert.doesNotMatch(out, /break each other|together they fail/);
  assert.equal(runs(out), 2);
});

test('verify says when the checks fail only with all lanes together', () => {
  const main = makeRepo('b4');
  onBase(main, 'all.js', "const fs = require('fs');\nprocess.exit(['a', 'b', 'c'].every((f) => fs.existsSync(f + '.txt')) ? 1 : 0);\n");
  laneWith('b4', 'feat-a', 'a.txt', 'a\n');
  laneWith('b4', 'feat-b', 'b.txt', 'b\n');
  sideLane('b4', 'feat-c', 'c.txt');
  const { result, out } = capture(() => cmdVerify('b4', { keep: false, cmds: ['node all.js'] }));
  assert.equal(result, 1, out);
  assert.match(out, /b4-1 \+ b4-2 \+ b4-3 +FAIL together/);
  assert.match(out, /every pair passes: the checks fail only with all 3 lanes together/);
  assert.equal(runs(out), 6);
});

test('verify stops the search at --bisect-max and says what is left; --no-bisect does not search', () => {
  makeRepo('b5');
  laneWith('b5', 'feat-a', 'a.txt', 'a\n');
  laneWith('b5', 'feat-b', 'b.txt', 'b\n');
  const capped = capture(() => cmdVerify('b5', { keep: false, bisectMax: 1 }));
  assert.equal(capped.result, 1, capped.out);
  assert.equal(runs(capped.out), 1);
  assert.match(capped.out, /No lane tested fails by itself; search stopped after 1 extra check run\(s\) \(--bisect-max 1\): 1 combination\(s\) not tested/);
  capture(() => lane.cmdDone('b5-3', { force: true }));

  const plain = capture(() => cmdVerify('b5', { keep: false, bisect: false }));
  assert.equal(plain.result, 1, plain.out);
  assert.equal(runs(plain.out), 0);
  assert.match(plain.out, /FAILS\. Each lane may pass on its own/);
  assert.doesNotMatch(plain.out, /alone/);
});

test('verify blames the base, not the lane, when the base fails with no lane merged', () => {
  makeRepo('b6');
  laneWith('b6', 'feat-y', 'y.txt', 'y\n');
  const { result, out } = capture(() => cmdVerify('b6', { keep: false, cmds: ['node missing.js'] }));
  assert.equal(result, 1, out);
  assert.match(out, /origin\/main +FAIL: "node missing\.js"/);
  assert.match(out, /origin\/main itself fails the checks, with no lane merged/);
  assert.doesNotMatch(out, /fails by itself/);
  assert.equal(runs(out), 1);
});

test('a conflict names the lane it is with, not every lane merged before', () => {
  makeRepo('b7');
  laneWith('b7', 'feat-c', 'base.txt', 'one\nC\n');
  laneWith('b7', 'feat-e', 'e.txt', 'e\n');
  const d = capture(() => cmdNew('b7', 'feat-d', { install: false, open: false, pool: 'side' })).result;
  fs.writeFileSync(path.join(d, 'base.txt'), 'one\nD\n');
  git(d, 'commit', '-q', '-am', 'change base.txt');
  const { result, out } = capture(() => cmdVerify('b7', { keep: false }));
  assert.equal(result, 1, out);
  assert.match(out, /b7-3 +feat-d +CONFLICT with b7-1 \(feat-c\): base\.txt$/m);
  assert.match(out, /2 lane\(s\) together on origin\/main: checks pass; 1 lane\(s\) conflict/);
  assert.equal(runs(out), 0, 'a conflict costs merges only');
  const slot = path.join(root, 'b7-4');
  assert.ok(fs.existsSync(path.join(slot, 'e.txt')), 'the lanes that merged are still merged in the slot');
  assert.equal(fs.readFileSync(path.join(slot, 'base.txt'), 'utf8').replace(/\r/g, ''), 'one\nC\n');
});

test('a lane that conflicts with the base itself says so', () => {
  const main = makeRepo('b8');
  laneWith('b8', 'feat-f', 'base.txt', 'one\nF\n');
  onBase(main, 'base.txt', 'one\nMAIN\n');
  const { result, out } = capture(() => cmdVerify('b8', { keep: false }));
  assert.equal(result, 1, out);
  assert.match(out, /CONFLICT with origin\/main itself: base\.txt/);
});
