import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { capture, git, lane, makeRepo, take } from './support.ts';

const { cmdClean, cmdDone } = lane;
const hasBranch = (main: string, b: string) => git(main, 'branch', '--list', b) !== '';

/** A slot for `task` whose work went on a branch of its own (as a tool in the slot does), pushed. */
function workElsewhere(repo: string, task: string, branch: string): string {
  const dir = take(repo, task);
  git(dir, 'switch', '-q', '-c', branch);
  fs.writeFileSync(path.join(dir, `${task}.txt`), 'x\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', `work for ${task}`);
  git(dir, 'push', '-q', 'origin', branch);
  return dir;
}

test("lane done deletes the task's branch the slot moved off, when it has no commits of its own", () => {
  const main = makeRepo('tb1');
  workElsewhere('tb1', 'REQ-001', 'aiws/REQ-001');
  assert.ok(hasBranch(main, 'REQ-001'));
  const { out } = capture(() => cmdDone('tb1-1', { force: false }));
  assert.match(out, /task branch REQ-001 deleted \(no commits of its own\)/);
  assert.equal(hasBranch(main, 'REQ-001'), false);
  assert.equal(hasBranch(main, 'aiws/REQ-001'), false, 'the pushed branch the slot was on goes as before');
});

test('a task branch with commits on no remote, or checked out elsewhere, is kept', () => {
  const main = makeRepo('tb2');
  const dir = take('tb2', 'mine');
  fs.writeFileSync(path.join(dir, 'm.txt'), 'm\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'local only');
  git(dir, 'switch', '-q', '-c', 'other', 'origin/main');
  capture(() => cmdDone('tb2-1', { force: false }));
  assert.ok(hasBranch(main, 'mine'), 'its commit is on no remote');

  const second = take('tb2', 'shared');
  git(second, 'switch', '-q', '--detach');
  git(main, 'switch', '-q', 'shared');
  capture(() => cmdDone(path.basename(second), { force: false }));
  assert.ok(hasBranch(main, 'shared'), 'checked out in the main clone');
  git(main, 'switch', '-q', 'main');
});

test('lane clean deletes such a branch left by a slot given back earlier', () => {
  const main = makeRepo('tb3');
  workElsewhere('tb3', 'review-pr1', 'review/pr1');
  capture(() => cmdDone('tb3-1', { force: false }));
  // as a give-back before this change left it
  git(main, 'branch', 'review-pr1', 'origin/main');
  const dry = capture(() => cmdClean({ yes: false, force: false })).out;
  assert.match(dry, /delete branch review-pr1 +\(task branch of tb3-1, no commits of its own\)/);
  assert.ok(hasBranch(main, 'review-pr1'), 'nothing done without --yes');
  capture(() => cmdClean({ yes: true, force: false }));
  assert.equal(hasBranch(main, 'review-pr1'), false);
});
