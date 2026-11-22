import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildSlots, costFor, depsLockName, detectKind, minFreeMemory, prepareArgv, vitestWorkers } from '../src/heavy.ts';

const GB = 1024 ** 3;

function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const old = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(old)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test('detectKind names the heavy tools, whether given as one line or as words', () => {
  assert.equal(detectKind(['npx vitest run']), 'vitest');
  assert.equal(detectKind(['node_modules/.bin/vitest.cmd', 'run']), 'vitest');
  assert.equal(detectKind(['npx', 'tsc', '--noEmit']), 'tsc');
  assert.equal(detectKind(['npx vue-tsc --noEmit']), 'tsc');
  assert.equal(detectKind(['npx eslint src/a.ts']), 'eslint');
  assert.equal(detectKind(['npx playwright test']), 'capture');
  assert.equal(detectKind(['docker compose up -d']), 'docker');
  assert.equal(detectKind(['docker-compose', 'up', '-d']), 'docker');
  assert.equal(detectKind(['python -m pytest tests']), 'pytest');
  assert.equal(detectKind(['npx vite build']), 'build');
  assert.equal(detectKind(['cargo', 'build', '--release']), 'build');
  assert.equal(detectKind(['./gradlew assembleDebug']), 'build');
  assert.equal(detectKind(['cargo test']), 'test');
  assert.equal(detectKind(['git status']), undefined);
  assert.equal(detectKind(['npm ci']), undefined);
});

test('costFor: --cost wins, else the kind, never above the slots', () => {
  assert.equal(costFor('vitest', 6), 2);
  assert.equal(costFor('eslint', 6), 1);
  assert.equal(costFor(undefined, 6), 1);
  assert.equal(costFor('tsc', 1), 1, 'a one-slot resource still runs a tsc');
  assert.equal(costFor('eslint', 6, 3), 3);
});

test('prepareArgv adds --maxWorkers to vitest started directly, and nowhere else', () => {
  withEnv({ LANE_VITEST_WORKERS: '2' }, () => {
    assert.deepEqual(prepareArgv(['npx', 'vitest', 'run']), ['npx', 'vitest', 'run', '--maxWorkers=2']);
    assert.deepEqual(prepareArgv(['vitest', 'run']), ['vitest', 'run', '--maxWorkers=2']);
    assert.deepEqual(prepareArgv(['pnpm', 'exec', 'vitest']), ['pnpm', 'exec', 'vitest', '--maxWorkers=2']);
    assert.deepEqual(prepareArgv(['npx', 'vitest', '--maxWorkers=4']), ['npx', 'vitest', '--maxWorkers=4']);
    assert.deepEqual(prepareArgv(['npx', 'vitest', '--pool=forks']), ['npx', 'vitest', '--pool=forks']);
    assert.deepEqual(prepareArgv(['npx vitest run']), ['npx vitest run'], 'a command line is left as typed');
    assert.deepEqual(prepareArgv(['npm', 'run', 'test']), ['npm', 'run', 'test'], 'a script is left alone');
  });
});

test('prepareArgv refuses docker compose up without -d', () => {
  assert.throws(() => prepareArgv(['docker compose up']), /add -d/);
  assert.throws(() => prepareArgv(['docker-compose', 'up', 'api']), /add -d/);
  assert.deepEqual(prepareArgv(['docker compose up -d']), ['docker compose up -d']);
  assert.deepEqual(prepareArgv(['docker', 'compose', 'up', '--detach']), ['docker', 'compose', 'up', '--detach']);
  assert.deepEqual(prepareArgv(['docker compose down']), ['docker compose down']);
});

test('depsLockName is one name per node_modules, found from a sub folder, and only for test runs and builds', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lane-heavy-'));
  fs.mkdirSync(path.join(root, 'node_modules'));
  fs.mkdirSync(path.join(root, 'src', 'deep'), { recursive: true });
  const name = depsLockName('vitest', path.join(root, 'src', 'deep'));
  assert.match(name ?? '', /^deps-[0-9a-f]{12}$/);
  assert.equal(depsLockName('build', root), name);
  assert.equal(depsLockName('eslint', root), undefined);
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'lane-heavy-'));
  fs.mkdirSync(path.join(other, 'node_modules'));
  assert.notEqual(depsLockName('vitest', other), name);
});

test('buildSlots: cores less 2, one per 4 GB, at least 2', () => {
  assert.equal(buildSlots(8, 32 * GB), 6);
  assert.equal(buildSlots(20, 16 * GB), 4);
  assert.equal(buildSlots(4, 8 * GB), 2);
  assert.equal(buildSlots(2, 4 * GB), 2);
});

test('vitestWorkers follows the cores unless LANE_VITEST_WORKERS is set', () => {
  withEnv({ LANE_VITEST_WORKERS: undefined }, () => {
    assert.equal(vitestWorkers(4), 1);
    assert.equal(vitestWorkers(8), 2);
    assert.equal(vitestWorkers(16), 3);
  });
  withEnv({ LANE_VITEST_WORKERS: '5' }, () => assert.equal(vitestWorkers(4), 5));
});

test('minFreeMemory: an eighth of the RAM, at least 3 GB; LANE_WITH_MIN_FREE_GB sets it, 0 turns it off', () => {
  withEnv({ LANE_WITH_MIN_FREE_GB: undefined }, () => {
    assert.equal(minFreeMemory(16 * GB), 3 * GB);
    assert.equal(minFreeMemory(64 * GB), 8 * GB);
  });
  withEnv({ LANE_WITH_MIN_FREE_GB: '0' }, () => assert.equal(minFreeMemory(16 * GB), 0));
  withEnv({ LANE_WITH_MIN_FREE_GB: '5' }, () => assert.equal(minFreeMemory(16 * GB), 5 * GB));
});
