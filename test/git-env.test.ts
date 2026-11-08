import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { gitEnv } from '../src/git-env.ts';
import { run, runLive, tryRun } from '../src/proc.ts';

test('gitEnv drops the repository variables, keeps the rest and merges extra', () => {
  const env = gitEnv({ GIT_TERMINAL_PROMPT: '0' }, {
    GIT_DIR: 'x',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'k',
    GIT_CONFIG_VALUE_0: 'v',
    GIT_AUTHOR_NAME: 'kept',
    PATH: 'p',
  });
  assert.deepEqual(env, { GIT_AUTHOR_NAME: 'kept', PATH: 'p', GIT_TERMINAL_PROMPT: '0' });
});

test('run with a folder reaches that repository while a hook GIT_DIR points elsewhere', (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lane-env-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const hook = path.join(tmp, 'hook');
  const target = path.join(tmp, 'target');
  for (const dir of [hook, target]) execFileSync('git', ['init', '-q', dir]);
  process.env.GIT_DIR = path.join(hook, '.git');
  t.after(() => delete process.env.GIT_DIR);
  const gitDir = run('git', ['rev-parse', '--absolute-git-dir'], target);
  assert.equal(fs.realpathSync.native(gitDir), fs.realpathSync.native(path.join(target, '.git')));
});

test('runLive runs in its folder while a hook GIT_DIR points elsewhere', (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lane-env-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const hook = path.join(tmp, 'hook');
  const target = path.join(tmp, 'target');
  for (const dir of [hook, target]) execFileSync('git', ['init', '-q', dir]);
  process.env.GIT_DIR = path.join(hook, '.git');
  t.after(() => delete process.env.GIT_DIR);
  assert.equal(runLive('git config lane.probe yes', target), true);
  delete process.env.GIT_DIR;
  assert.equal(run('git', ['config', '--get', 'lane.probe'], target), 'yes');
  assert.equal(tryRun('git', ['config', '--get', 'lane.probe'], hook), null);
});
