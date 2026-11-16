import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { capture, git, lane, locked, makeRepo, root } from './support.ts';
import { disk } from '../src/fsutil.ts';

const { cmdDone, cmdList, cmdMove, cmdNew } = lane;
const spare = path.join(path.dirname(root), 'wt-spare');
const at = (dir: string) => `${path.basename(path.dirname(dir))}/${path.basename(dir)}`;
const where = (main: string, slot: string) =>
  at(git(main, 'worktree', 'list', '--porcelain').split(/\r?\n/).find((l) => l.startsWith('worktree ') && l.endsWith(slot))?.slice(9) ?? '');

/** Both roots are on one drive here: the free space per root, and whether a move crosses drives, are set per test. */
function withRoots(free: Record<string, number>, crossDrive: boolean, fn: () => void): void {
  const real = { freeGb: disk.freeGb, sameDrive: disk.sameDrive };
  disk.freeGb = (dir) => free[dir] ?? null;
  disk.sameDrive = () => !crossDrive;
  process.env.LANE_ROOT_SPARE = spare;
  try {
    fn();
  } finally {
    Object.assign(disk, real);
    delete process.env.LANE_ROOT_SPARE;
  }
}

/** A slot made on the spare root (the lane root short of space), for `task`. */
function onSpare(repo: string, task: string, opts: { sparse?: string[] } = {}): string {
  const real = disk.freeGb;
  disk.freeGb = (dir) => (dir === root ? 2 : 80);
  try {
    return capture(() => cmdNew(repo, task, { install: false, open: false, ...opts })).result;
  } finally {
    disk.freeGb = real;
  }
}

test('a free slot moves to the lane root on the same drive, and stays free', () => {
  const main = makeRepo('mv1');
  withRoots({ [root]: 80, [spare]: 80 }, false, () => {
    onSpare('mv1', 'one');
    capture(() => cmdDone('mv1-1', { force: true }));
    assert.equal(where(main, 'mv1-1'), 'wt-spare/mv1-1');
    const { out } = capture(() => cmdMove('mv1-1', { to: 'main' }));
    assert.match(out, /moved mv1-1 to .*wt.mv1-1/);
    assert.equal(where(main, 'mv1-1'), 'wt/mv1-1');
    assert.equal(locked(main, 'mv1-1'), null, 'the lock lane took for the move is gone');
    assert.match(capture(() => cmdList({ local: true })).out, /mv1-1 +free \(last: one\)/);
    assert.throws(() => cmdMove('mv1-1', { to: 'main' }), /already on the lane root/);
  });
});

test('across drives the slot is made again: same branch, sparse folders and hold; the holder only', () => {
  const main = makeRepo('mv2');
  fs.mkdirSync(path.join(main, 'app'));
  fs.writeFileSync(path.join(main, 'app', 'a.txt'), 'a\n');
  fs.mkdirSync(path.join(main, 'docs'));
  fs.writeFileSync(path.join(main, 'docs', 'd.txt'), 'd\n');
  git(main, 'add', '-A');
  git(main, 'commit', '-q', '-m', 'folders');
  git(main, 'push', '-q', 'origin', 'main');
  withRoots({ [root]: 80, [spare]: 80 }, true, () => {
    const dir = onSpare('mv2', 'feat', { sparse: ['app'] });
    const reason = locked(main, 'mv2-1') ?? '';
    const lease = reason.split('#')[1] ?? '';
    assert.throws(() => cmdMove('mv2-1', { to: 'main' }), /held for feat; only its holder moves it/);
    assert.throws(() => cmdMove('mv2-1', { to: 'main', lease: 'nope' }), /held for feat/);

    fs.writeFileSync(path.join(dir, 'app', 'b.txt'), 'b\n');
    assert.throws(() => cmdMove('mv2-1', { to: 'main', lease }), /uncommitted or unpushed work/);
    assert.equal(where(main, 'mv2-1'), 'wt-spare/mv2-1', 'refused before anything moved');
    fs.rmSync(path.join(dir, 'app', 'b.txt'));

    const { out } = capture(() => cmdMove('mv2-1', { to: 'main', lease }));
    assert.match(out, /moved mv2-1 to .*wt.mv2-1 \(made again there/);
    assert.equal(where(main, 'mv2-1'), 'wt/mv2-1');
    assert.equal(fs.existsSync(path.join(spare, 'mv2-1')), false, 'the old folder is gone');
    assert.equal(locked(main, 'mv2-1'), reason, 'held as before, same lease');
    const moved = path.join(root, 'mv2-1');
    assert.equal(git(moved, 'branch', '--show-current'), 'feat');
    assert.equal(fs.existsSync(path.join(moved, 'app', 'a.txt')), true);
    assert.equal(fs.existsSync(path.join(moved, 'docs')), false, 'still sparse');
  });
});

test('a move needs a spare root and room on the drive it goes to', () => {
  makeRepo('mv3');
  assert.throws(() => cmdMove('mv3-1', { to: 'spare' }), /no lane called mv3-1/);
  capture(() => cmdNew('mv3', 'one', { install: false, open: false }));
  capture(() => cmdDone('mv3-1', { force: true }));
  assert.throws(() => cmdMove('mv3-1', { to: 'spare' }), /no spare root: set LANE_ROOT_SPARE/);
  withRoots({ [root]: 80, [spare]: 3 }, false, () => {
    assert.throws(() => cmdMove('mv3-1', { to: 'spare' }), /has 3\.0 GB free, under 10 GB \(LANE_MIN_FREE_GB\)/);
    assert.throws(() => cmdMove('mv3-1', { to: 'elsewhere' as 'main' }), /--to takes main or spare/);
  });
});

test('lane list points at slots on the spare root once the lane root has room again', () => {
  makeRepo('mv4');
  withRoots({ [root]: 2, [spare]: 80 }, false, () => {
    onSpare('mv4', 'one');
    assert.doesNotMatch(capture(() => cmdList({ local: true })).out, /lane move/, 'no hint while the lane root is short');
    disk.freeGb = () => 80;
    assert.match(capture(() => cmdList({ local: true })).out, /mv4-1 is on the spare root.*lane move mv4-1 --to main --lease <the hold's lease> \(its holder\)/);
    capture(() => cmdDone('mv4-1', { force: true }));
    assert.match(capture(() => cmdList({ local: true })).out, /lane move mv4-1 --to main$/m, 'a free slot: no lease needed');
    assert.doesNotMatch(capture(() => cmdList({ local: true, json: true })).out, /lane move/, 'JSON stays JSON only');
  });
});
