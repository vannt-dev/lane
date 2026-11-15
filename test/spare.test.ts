import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { capture, lane, locked, makeRepo, root } from './support.ts';
import { disk, rootForNewSlot } from '../src/fsutil.ts';

const { cmdClean, cmdDone, cmdList, cmdNew, cmdRemove } = lane;
const spare = path.join(path.dirname(root), 'wt-spare');
/** `<root folder>/<slot>` of a lane path, however git spells the rest. */
const where = (dir: string) => `${path.basename(path.dirname(dir))}/${path.basename(dir)}`;
const newLane = (task: string) => {
  const { result, out } = capture(() => cmdNew('sp1', task, { install: false, open: false }));
  return { at: where(result), out };
};

/** Both roots are on one drive here, so the free space is a figure per root. */
function withDisk(free: Record<string, number | null>, fn: () => void): void {
  const real = disk.freeGb;
  disk.freeGb = (dir) => free[dir] ?? null;
  process.env.LANE_ROOT_SPARE = spare;
  try {
    fn();
  } finally {
    disk.freeGb = real;
    delete process.env.LANE_ROOT_SPARE;
    delete process.env.LANE_MIN_FREE_GB;
  }
}

test('the root for a new slot is the first with room; none refuses with the figures', () => {
  withDisk({ a: 3, b: 40 }, () => {
    assert.equal(rootForNewSlot(['a', 'b'], 0), 'a', 'no check without a minimum');
    assert.equal(rootForNewSlot(['a', 'b'], 2), 'a');
    assert.match(capture(() => assert.equal(rootForNewSlot(['a', 'b'], 10), 'b')).out, /a has 3\.0 GB free, under 10 GB.*goes to b/);
    assert.equal(rootForNewSlot(['unreadable', 'b'], 10), 'unreadable', 'a drive that cannot be read is not held full');
    assert.throws(() => rootForNewSlot(['a', 'b'], 50), /no room for a new slot: a has 3\.0 GB free, b has 40\.0 GB free, under 50 GB/);
    assert.throws(() => rootForNewSlot(['a'], 50), /LANE_ROOT_SPARE/);
  });
});

test('a new slot goes to the spare root when the lane root is short of space, and lives there like any slot', () => {
  const main = makeRepo('sp1');
  withDisk({ [root]: 2, [spare]: 80 }, () => {
    const first = newLane('one');
    assert.equal(first.at, 'wt-spare/sp1-1');
    assert.match(first.out, /under 10 GB: the new slot goes to/, 'the minimum is 10 GB once a spare root is named');
    assert.match(capture(() => cmdList({ local: true })).out, /sp1-1 +held: one/);

    // given back, then taken again: found and locked where it is, even now that the lane root has room
    capture(() => cmdDone('sp1-1', { force: true }));
    disk.freeGb = () => 80;
    assert.equal(newLane('two').at, 'wt-spare/sp1-1');
    assert.match(locked(main, 'sp1-1') ?? '', /^two @/);
    // the next new slot has room on the lane root; numbers stay one series over both roots
    assert.equal(newLane('three').at, 'wt/sp1-2');

    // a folder lane does not know, in the spare root, is a leftover like one in the lane root
    fs.mkdirSync(path.join(spare, 'stray'));
    assert.match(capture(() => cmdClean({ yes: false, force: false })).out, /remove +.*wt-spare.stray +\(folder no repository knows\)/);
    fs.rmdirSync(path.join(spare, 'stray'));

    capture(() => cmdRemove('sp1-1', { force: true }));
    assert.equal(fs.existsSync(path.join(spare, 'sp1-1')), false);

    // no root with room: refused before anything is made
    process.env.LANE_MIN_FREE_GB = '500';
    assert.throws(() => newLane('four'), /no room for a new slot: .* under 500 GB/);
    assert.equal(fs.existsSync(path.join(root, 'sp1-1')), false);
  });
});

test('a spare root inside the lane root (or around it) is refused: clean would take its slots for leftovers', () => {
  for (const bad of [path.join(root, 'more'), path.dirname(root), root]) {
    process.env.LANE_ROOT_SPARE = bad;
    try {
      assert.throws(() => cmdList({ local: true }), /LANE_ROOT_SPARE .* must be a folder of its own/);
    } finally {
      delete process.env.LANE_ROOT_SPARE;
    }
  }
});

test('a spare root that is a link into the lane root is refused too', () => {
  fs.mkdirSync(path.join(root, 'inner'), { recursive: true });
  const link = path.join(path.dirname(root), 'wt-link');
  fs.symlinkSync(path.join(root, 'inner'), link, 'junction');
  process.env.LANE_ROOT_SPARE = link;
  try {
    assert.throws(() => cmdList({ local: true }), /LANE_ROOT_SPARE .* must be a folder of its own/);
  } finally {
    delete process.env.LANE_ROOT_SPARE;
    // a junction goes with rmdir on Windows, a symlink with unlink elsewhere
    if (process.platform === 'win32') fs.rmdirSync(link);
    else fs.unlinkSync(link);
    fs.rmdirSync(path.join(root, 'inner'));
  }
});
