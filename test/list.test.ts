import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { capture, git, lane, laneWith, makeRepo, root } from './support.ts';
import { disk, samePath } from '../src/fsutil.ts';
import type { LaneInfo } from '../src/housekeeping.ts';

const { cmdDone, cmdList, cmdNew } = lane;
const listJson = (local = true) =>
  (JSON.parse(capture(() => cmdList({ local, json: true })).out) as LaneInfo[]).sort((x, y) => x.name.localeCompare(y.name));
const FIELDS = [
  'name', 'repo', 'slot', 'path', 'pool', 'state', 'task', 'lease', 'heldSince', 'heldMs', 'abandoned', 'idleMs',
  'branch', 'sparse', 'changed', 'unpushed',
];

test('list --json with no lanes is an empty array', () => {
  assert.equal(capture(() => cmdList({ local: true, json: true })).out, '[]');
});

test('list --json gives every lane with its hold, branch, pool, sparse folders and local work', () => {
  const main = makeRepo('lj1');
  fs.mkdirSync(path.join(main, 'docs'));
  fs.writeFileSync(path.join(main, 'docs', 'guide.md'), 'guide\n');
  git(main, 'add', '-A');
  git(main, 'commit', '-q', '-m', 'docs');
  git(main, 'push', '-q', 'origin', 'main');

  const a = laneWith('lj1', 'feat-a', 'a.txt', 'a\n');
  fs.writeFileSync(path.join(a, 'note.txt'), 'not committed\n');
  capture(() => cmdNew('lj1', 'rev-b', { install: false, open: false, pool: 'review', sparse: ['docs'] }));
  capture(() => cmdNew('lj1', 'feat-c', { install: false, open: false }));
  capture(() => cmdDone('lj1-3', { force: false }));

  const [one, two, three, ...rest] = listJson();
  assert.equal(rest.length, 0);
  assert.ok(one && two && three);
  for (const l of [one, two, three]) assert.deepEqual(Object.keys(l), FIELDS, 'the same fields, in the same order, and no pr with --local');

  assert.deepEqual(
    { name: one.name, repo: one.repo, slot: one.slot, pool: one.pool, state: one.state, task: one.task, branch: one.branch },
    { name: 'lj1-1', repo: 'lj1', slot: 1, pool: null, state: 'held', task: 'feat-a', branch: 'feat-a' },
  );
  assert.ok(samePath(one.path, a), one.path);
  assert.match(one.lease ?? '', /^[0-9a-f]+$/);
  assert.ok(Math.abs(Date.parse(one.heldSince ?? '') - Date.now()) < 120_000, String(one.heldSince));
  assert.equal(typeof one.heldMs, 'number');
  assert.equal(one.abandoned, false);
  assert.deepEqual([one.sparse, one.changed, one.unpushed], [[], 1, 1]);

  assert.deepEqual([two.name, two.pool, two.state, two.task, two.sparse], ['lj1-2', 'review', 'held', 'rev-b', ['docs']]);
  assert.deepEqual([two.changed, two.unpushed], [0, 0]);

  assert.deepEqual(
    [three.state, three.task, three.lease, three.heldSince, three.heldMs, three.branch, three.changed, three.unpushed],
    ['free', 'feat-c', null, null, null, null, 0, null],
  );

  // without --local each lane on a branch says whether it has a pull request (none: not on GitHub)
  const asked = listJson(false);
  assert.deepEqual(asked.map((l) => 'pr' in l), [true, true, false]);
  assert.equal(asked[0]?.pr, null);

  // the table is made from the same data
  const table = capture(() => cmdList({ local: true })).out;
  assert.match(table, /lj1-1 +held: feat-a, \d+ min +feat-a +1 changed, 1 unpushed +-/);
  assert.match(table, /lj1-2 \(review\) +held: rev-b, \d+ min +rev-b \(sparse: docs\) +0 changed, 0 unpushed/);
  assert.match(table, /lj1-3 +free \(last: feat-c\) +\(detached\) +0 changed +-/);
});

test('list --json names slots on the spare root too, with their path', () => {
  makeRepo('lj2');
  const spare = path.join(path.dirname(root), 'wt-spare');
  const real = disk.freeGb;
  process.env.LANE_ROOT_SPARE = spare;
  try {
    disk.freeGb = (dir) => (dir === root ? 2 : 80);
    capture(() => cmdNew('lj2', 'on-spare', { install: false, open: false }));
    disk.freeGb = () => 80;
    capture(() => cmdNew('lj2', 'on-root', { install: false, open: false }));
    const lanes = listJson().filter((l) => l.repo === 'lj2');
    assert.deepEqual(lanes.map((l) => [l.name, l.task, path.basename(path.dirname(l.path))]).sort(), [
      ['lj2-1', 'on-spare', 'wt-spare'],
      ['lj2-2', 'on-root', 'wt'],
    ]);
  } finally {
    disk.freeGb = real;
    delete process.env.LANE_ROOT_SPARE;
  }
});

test('the lane list --json command prints the JSON array and nothing else', () => {
  const bin = path.join(import.meta.dirname, '..', 'bin', 'lane.ts');
  const env = { ...process.env, LANE_ROOT_SPARE: path.join(path.dirname(root), 'wt-spare') };
  const run = spawnSync(process.execPath, [bin, 'list', '--json', '--local'], { encoding: 'utf8', env });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stderr, '');
  const lanes = JSON.parse(run.stdout) as LaneInfo[];
  assert.deepEqual(lanes.map((l) => l.name).sort(), ['lj1-1', 'lj1-2', 'lj1-3', 'lj2-1', 'lj2-2']);
});
