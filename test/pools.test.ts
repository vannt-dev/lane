import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { capture, lane, makeRepo } from './support.ts';

const { cmdDone, cmdList, cmdNew } = lane;
const newLane = (task: string, pool?: string) => capture(() => cmdNew('pl1', task, { install: false, open: false, pool })).result;

test('a review pool keeps its slots apart from the default pool, with its own max', () => {
  makeRepo('pl1');
  process.env.LANE_POOLS = 'review=1';
  try {
    assert.equal(path.basename(newLane('dev-a')), 'pl1-1');
    assert.equal(path.basename(newLane('rev-a', 'review')), 'pl1-2');
    capture(() => cmdDone('pl1-2', { force: true }));
    // the free review slot is not taken by default-pool work, which gets a new number
    assert.equal(path.basename(newLane('dev-b')), 'pl1-3');
    assert.equal(path.basename(newLane('rev-b', 'review')), 'pl1-2', 'review work reuses the review slot');
    const full = () => cmdNew('pl1', 'rev-c', { install: false, open: false, pool: 'review' });
    const { out } = capture(() => assert.throws(full, /all 1 slots of pl1 in pool review are in use/));
    assert.match(out, /pl1-2 +held: rev-b/);
    assert.match(capture(() => cmdList({ local: true })).out, /pl1-2 \(review\) +held: rev-b/);
    assert.throws(() => newLane('x', 'Bad Name'), /--pool/);
  } finally {
    delete process.env.LANE_POOLS;
  }
});
