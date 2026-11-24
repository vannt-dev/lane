// A backup ref before lane throws a slot's work away (lane rm --force, lane clean).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { capture, git, lane, laneWith, makeRepo, take } from './support.ts';

const { cmdBackups, cmdClean, cmdRemove } = lane;

const refsOf = (main: string, slot: string) =>
  git(main, 'for-each-ref', '--format=%(refname)', `refs/lane-backup/${slot}/`).split('\n').filter(Boolean);

/** A slot with an unpushed commit, a changed file, a staged new file, an untracked one and an ignored one. */
function dirtySlot(repo: string, task: string): { dir: string; head: string } {
  const dir = laneWith(repo, task, 'a.txt', 'committed\n');
  fs.writeFileSync(path.join(dir, 'base.txt'), 'one\nchanged\n');
  fs.writeFileSync(path.join(dir, 'staged.txt'), 'staged\n');
  git(dir, 'add', 'staged.txt');
  fs.writeFileSync(path.join(dir, 'new.txt'), 'untracked\n');
  fs.mkdirSync(path.join(dir, 'cache'));
  fs.writeFileSync(path.join(dir, 'cache', 'big.bin'), 'ignored\n');
  return { dir, head: git(dir, 'rev-parse', 'HEAD') };
}

test('lane rm --force saves the uncommitted, untracked and unpushed work under a backup ref first', () => {
  const main = makeRepo('b1');
  const { head } = dirtySlot('b1', 'feat-a');
  const { out } = capture(() => cmdRemove('b1-1', { force: true }));
  const [ref, ...more] = refsOf(main, 'b1-1');
  assert.ok(ref, 'a backup ref');
  assert.equal(more.length, 0);
  assert.ok(out.includes(`backup of b1-1: ${ref}`), out);
  assert.match(out, /3 uncommitted, 1 unpushed commit/);
  assert.ok(out.includes(`git checkout ${ref} -- .`), 'says how to restore the files');
  assert.ok(out.includes(`git branch feat-a ${ref}~1`), 'and the branch');
  assert.match(out, /removed b1-1 and local branch feat-a/);
  assert.equal(git(main, 'rev-parse', `${ref}~1`), head, 'the branch head is its parent');
  assert.equal(git(main, 'show', `${ref}:base.txt`), 'one\nchanged');
  assert.equal(git(main, 'show', `${ref}:staged.txt`), 'staged');
  assert.equal(git(main, 'show', `${ref}:new.txt`), 'untracked');
  assert.equal(git(main, 'show', `${ref}:a.txt`), 'committed');
  assert.throws(() => git(main, 'show', `${ref}:cache/big.bin`), 'ignored files are left out');
  assert.match(git(main, 'log', '-1', '--format=%B', ref), /lane backup of b1-1 \(feat-a\) before lane rm/);

  // restored into a fresh slot: the same files as before
  const fresh = take('b1', 'feat-again');
  git(fresh, 'checkout', ref ?? '', '--', '.');
  assert.equal(git(fresh, 'diff', '--cached', '--stat', ref ?? ''), '', 'nothing differs from the backup');
  // core.autocrlf (Windows) may write it back with CRLF
  assert.equal(fs.readFileSync(path.join(fresh, 'new.txt'), 'utf8').replace(/\r\n/g, '\n'), 'untracked\n');
});

test('no backup when nothing would be lost', () => {
  const main = makeRepo('b2');
  const dir = take('b2', 'feat-a');
  fs.mkdirSync(path.join(dir, 'cache'));
  fs.writeFileSync(path.join(dir, 'cache', 'ignored.bin'), 'x\n');
  const { out } = capture(() => cmdRemove('b2-1', { force: true }));
  assert.doesNotMatch(out, /backup/);
  assert.deepEqual(refsOf(main, 'b2-1'), []);
});

test('only the newest LANE_KEEP_BACKUPS backups of a lane are kept; 0 makes none', () => {
  const main = makeRepo('b3');
  process.env.LANE_KEEP_BACKUPS = '2';
  try {
    for (const task of ['t1', 't2', 't3']) {
      const dir = take('b3', task);
      fs.writeFileSync(path.join(dir, `${task}.txt`), `${task}\n`);
      capture(() => cmdRemove('b3-1', { force: true }));
    }
    const refs = refsOf(main, 'b3-1');
    assert.equal(refs.length, 2);
    const files = refs.map((r) => git(main, 'ls-tree', '--name-only', r).split('\n').filter((f) => /^t\d/.test(f)).join());
    assert.deepEqual(files.sort(), ['t2.txt', 't3.txt'], 'the oldest one went');

    process.env.LANE_KEEP_BACKUPS = '0';
    const dir = take('b3', 't4');
    fs.writeFileSync(path.join(dir, 't4.txt'), 't4\n');
    const { out } = capture(() => cmdRemove('b3-1', { force: true }));
    assert.doesNotMatch(out, /backup/);
    assert.equal(refsOf(main, 'b3-1').length, 2, 'the old ones stay');
  } finally {
    delete process.env.LANE_KEEP_BACKUPS;
  }
});

test('lane clean keeps the unpushed commits of a lane whose folder is gone', () => {
  const main = makeRepo('b4');
  const dir = laneWith('b4', 'feat-a', 'a.txt', 'a\n');
  const head = git(dir, 'rev-parse', 'HEAD');
  fs.rmSync(dir, { recursive: true, force: true });
  const { out } = capture(() => cmdClean({ yes: true, force: false }));
  const [ref] = refsOf(main, 'b4-1');
  assert.ok(ref, out);
  assert.match(out, /1 unpushed commit/);
  assert.equal(git(main, 'rev-parse', `${ref}~1`), head);
  assert.throws(() => git(main, 'rev-parse', '-q', '--verify', 'refs/heads/feat-a'), 'the branch is gone');
});

test('lane backups lists the backups with how to restore and drop them', () => {
  makeRepo('b5');
  const dir = take('b5', 'feat-a');
  fs.writeFileSync(path.join(dir, 'x.txt'), 'x\n');
  capture(() => cmdRemove('b5-1', { force: true }));
  const { out } = capture(() => cmdBackups('b5'));
  assert.match(out, /refs\/lane-backup\/b5-1\/\S+ +.+ +lane backup of b5-1 \(feat-a\) before lane rm/);
  assert.match(out, /git checkout <ref> -- \./);
  assert.match(out, /git update-ref -d <ref>/);
  assert.match(capture(() => cmdBackups('b2')).out, /no backups/);
});
