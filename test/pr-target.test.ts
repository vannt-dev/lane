import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { capture, git, laneWith, makeRepo, remotes, take } from './support.ts';
import { MainClone } from '../src/checkout.ts';
import { SlotPool } from '../src/pool.ts';
import { prTarget } from '../src/target.ts';

test('a pull request whose branch is checked out in another slot gets a slot detached at its head', () => {
  makeRepo('pt1');
  const writer = laneWith('pt1', 'feat', 'a.txt', 'a\n');
  git(writer, 'push', '-q', 'origin', 'feat');
  const pushed = git(writer, 'rev-parse', 'HEAD');
  fs.writeFileSync(path.join(writer, 'b.txt'), 'b\n');
  git(writer, 'add', 'b.txt');
  git(writer, 'commit', '-q', '-m', 'not pushed yet');

  const clone = new MainClone('pt1');
  const { result: target, out } = capture(() => prTarget(clone, 7, { headRefName: 'feat', isCrossRepository: false }));
  assert.match(out, /branch feat is checked out in .*pt1-1; this lane is detached at the pull request's head/);
  const { lane } = capture(() => new SlotPool(clone).take('review-7', target)).result;
  assert.equal(lane.branch, '', 'detached');
  assert.equal(git(lane.dir, 'rev-parse', 'HEAD'), pushed, "at the pull request's head, as pushed");
  assert.equal(git(writer, 'branch', '--show-current'), 'feat', 'the writer keeps its branch');
});

test("a fork's pull request whose pr-<n> branch is checked out elsewhere is detached too", () => {
  makeRepo('pt2');
  const fork = laneWith('pt2', 'fork-work', 'f.txt', 'f\n');
  const head = git(fork, 'rev-parse', 'HEAD');
  git(fork, 'push', '-q', 'origin', `${head}:refs/pull/8/head`);
  git(fork, 'branch', 'pr-8', head);
  const other = take('pt2', 'holder');
  git(other, 'switch', '-q', 'pr-8');

  const clone = new MainClone('pt2');
  const { result: target, out } = capture(() => prTarget(clone, 8, { headRefName: 'fork-work', isCrossRepository: true }));
  assert.match(out, /branch pr-8 is checked out in .*pt2-2/);
  assert.equal(target.describe(), `detached at ${head}`);
});

test('a pull request whose branch is not here yet is tracked as before', () => {
  makeRepo('pt3');
  const w = laneWith('pt3', 'side', 's.txt', 's\n');
  git(w, 'push', '-q', 'origin', 'side:topic');
  const clone = new MainClone('pt3');
  const target = capture(() => prTarget(clone, 9, { headRefName: 'topic', isCrossRepository: false })).result;
  assert.equal(target.describe(), 'branch topic, tracking origin/topic');
  assert.ok(fs.existsSync(path.join(remotes, 'pt3.git')));
});
