import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const bin = path.join(import.meta.dirname, '..', 'bin', 'lane.ts');

function laneWithout(...args: string[]) {
  const env = { ...process.env };
  delete env.LANE_ROOT;
  delete env.LANE_REPOS;
  return spawnSync(process.execPath, [bin, ...args], { env, encoding: 'utf8' });
}

test('without LANE_ROOT and LANE_REPOS, help still prints and a command names the variable', () => {
  const help = laneWithout('--help');
  assert.equal(help.status, 0);
  assert.match(help.stdout, /\$LANE_ROOT\/<repo>-<n>/);
  const list = laneWithout('list');
  assert.notEqual(list.status, 0);
  assert.match(list.stderr, /LANE_(ROOT|REPOS) is not set: point it at the folder/);
});
