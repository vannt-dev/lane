import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseHooks } from '../src/hooks.ts';
import { capture, git, lane, laneWith, locked, makeRepo, take } from './support.ts';

const { cmdClean, cmdDone, cmdNew } = lane;

// node runs the same way in cmd.exe and sh; the double quotes work in both
const write = (file: string, text: string) => `node -e "require('fs').writeFileSync('${file}', ${text})"`;
const fail = 'node -e "process.exit(3)"';

test('parseHooks reads .lane.json: a command or a list per key, nothing when absent', () => {
  assert.deepEqual(parseHooks(null), { postCreate: [], preDone: [] });
  assert.deepEqual(parseHooks('{"postCreate": ["npm run codegen", " cp a b "], "preDone": "docker compose down"}'), {
    postCreate: ['npm run codegen', 'cp a b'], preDone: ['docker compose down'],
  });
  assert.deepEqual(parseHooks('{"$schema": "x", "postCreate": []}'), { postCreate: [], preDone: [] });
});

test('parseHooks says what is wrong with a .lane.json', () => {
  assert.throws(() => parseHooks('{"postCreate": ['), /\.lane\.json is not valid JSON/);
  assert.throws(() => parseHooks('["npm run codegen"]'), /must be an object/);
  assert.throws(() => parseHooks('{"postcreate": []}'), /unknown key "postcreate" \(known: postCreate, preDone\)/);
  assert.throws(() => parseHooks('{"postCreate": [1]}'), /"postCreate" must be a command line or a list of them/);
  assert.throws(() => parseHooks('{"preDone": [""]}'), /"preDone" must be/);
});

test('postCreate runs in the new lane after setup, with the lane variables', () => {
  const main = makeRepo('hk1');
  const hooks = { postCreate: [write('made.txt', "process.env.LANE_NAME + ':' + process.env.LANE_MAIN")] };
  fs.writeFileSync(path.join(main, '.lane.json'), JSON.stringify(hooks));
  const dir = take('hk1', 'feat-a');
  assert.equal(fs.readFileSync(path.join(dir, 'made.txt'), 'utf8'), `hk1-1:${main}`);
});

test('a failing postCreate stops lane new and keeps the lane held; a broken .lane.json takes no slot', () => {
  const main = makeRepo('hk2');
  fs.writeFileSync(path.join(main, '.lane.json'), JSON.stringify({ postCreate: fail }));
  assert.throws(() => capture(() => cmdNew('hk2', 'feat-b', { install: false, open: false })),
    /\.lane\.json postCreate "node -e "process\.exit\(3\)"" failed in .*hk2-1; the lane is kept and held/);
  assert.match(locked(main, 'hk2-1') ?? '', /^feat-b @/);
  fs.writeFileSync(path.join(main, '.lane.json'), '{"postCreate": ');
  assert.throws(() => capture(() => cmdNew('hk2', 'feat-c', { install: false, open: false })), /not valid JSON/);
  assert.equal(fs.existsSync(path.join(path.dirname(path.dirname(main)), 'wt', 'hk2-2')), false);
});

test('preDone runs before lane done gives the slot back; when it fails the slot stays held', () => {
  const main = makeRepo('hk3');
  const dir = take('hk3', 'feat-d');
  fs.writeFileSync(path.join(main, '.lane.json'), JSON.stringify({ preDone: [fail] }));
  assert.throws(() => capture(() => cmdDone('hk3-1', { force: false })), /preDone .* failed .*hk3-1 is still held/);
  assert.match(locked(main, 'hk3-1') ?? '', /^feat-d @/);
  // its own output, so the lane stays clean enough to give back
  fs.writeFileSync(path.join(main, '.lane.json'), JSON.stringify({ preDone: write('../hk3-down.txt', "'down'") }));
  capture(() => cmdDone('hk3-1', { force: false }));
  assert.equal(fs.readFileSync(path.join(path.dirname(dir), 'hk3-down.txt'), 'utf8'), 'down');
  assert.equal(locked(main, 'hk3-1'), null);
});

test('lane clean keeps a merged lane whose preDone fails and says why', () => {
  const main = makeRepo('hk4');
  laneWith('hk4', 'feat-e', 'e.txt', 'e');
  git(main, 'merge', '--squash', '-q', 'feat-e');
  git(main, 'commit', '-q', '-m', 'squash feat-e');
  git(main, 'push', '-q', 'origin', 'main');
  fs.writeFileSync(path.join(main, '.lane.json'), JSON.stringify({ preDone: fail }));
  const { out } = capture(() => cmdClean({ yes: true, force: true }));
  assert.match(out, /kept {7}hk4-1 {2}\(\.lane\.json preDone/);
  assert.match(locked(main, 'hk4-1') ?? '', /^feat-e @/);
});
