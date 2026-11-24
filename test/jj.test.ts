import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { capture, git, lane, locked, makeRepo, repos } from './support.ts';
import { samePath } from '../src/fsutil.ts';
import type { LaneInfo } from '../src/housekeeping.ts';
import { jjKind, jjSupported, parseJjVersion, parseWorkspaces, workspaceAt } from '../src/jj.ts';
import { briefText } from '../src/text.ts';

const { cmdBrief, cmdDone, cmdList, cmdMove, cmdNew, cmdRemove } = lane;

// jj reads the user's config; the tests use an empty one and name the author by environment.
const jjHome = fs.mkdtempSync(path.join(os.tmpdir(), 'lane-jj-'));
fs.writeFileSync(path.join(jjHome, 'config.toml'), '');
process.env.JJ_CONFIG = path.join(jjHome, 'config.toml');
process.env.JJ_USER = 'test';
process.env.JJ_EMAIL = 'test@example.com';
test.after(() => fs.rmSync(jjHome, { recursive: true, force: true }));

const jj = (cwd: string, ...args: string[]) =>
  execFileSync('jj', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const version = (() => {
  try {
    return parseJjVersion(jj(os.tmpdir(), '--version'));
  } catch {
    return null;
  }
})();
const noJj = version && jjSupported(version) ? false : `needs jj 0.46 or later on PATH (found ${version ? version.join('.') : 'none'})`;
const workspaces = (main: string) => jj(main, '--ignore-working-copy', 'workspace', 'list', '-T', 'name ++ "\\n"').split(/\r?\n/);

test('parseJjVersion and jjSupported: colocated workspaces need jj 0.46', () => {
  assert.deepEqual(parseJjVersion('jj 0.47.1-d16ee1fc88a72c54142241b079a34bbf3b033bc0'), [0, 47]);
  assert.deepEqual(parseJjVersion('jj 1.2.0'), [1, 2]);
  assert.equal(parseJjVersion('git version 2.53.0'), null);
  assert.equal(jjSupported([0, 45]), false);
  assert.equal(jjSupported([0, 46]), true);
  assert.equal(jjSupported([1, 0]), true);
});

test('parseWorkspaces reads the tab-separated list, and workspaceAt finds one by its folder', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lane-jjws-'));
  const list = parseWorkspaces(`default\t${dir}\tyvlxlurx\r\nrepo-1\t${path.join(dir, 'gone')}\ttrywxrnx\n\n`);
  assert.deepEqual(list.map((w) => [w.name, w.change]), [['default', 'yvlxlurx'], ['repo-1', 'trywxrnx']]);
  assert.equal(workspaceAt(list, dir)?.name, 'default');
  assert.equal(workspaceAt(list, path.join(dir, 'gone'))?.name, 'repo-1', 'a folder that is gone already');
  assert.equal(workspaceAt(list, path.join(dir, 'other')), undefined);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('jjKind tells plain git, colocated jj and jj without .git apart', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lane-jjkind-'));
  assert.equal(jjKind(dir), 'none');
  fs.mkdirSync(path.join(dir, '.jj'));
  assert.equal(jjKind(dir), 'separate');
  fs.mkdirSync(path.join(dir, '.git'));
  assert.equal(jjKind(dir), 'colocated');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a jj repository that is not colocated with git is refused with what to do', () => {
  fs.mkdirSync(path.join(repos, 'jjsep', '.jj'), { recursive: true });
  assert.throws(() => cmdNew('jjsep', 'feat-a', { install: false, open: false }), /not colocated with git.*jj git colocation enable/);
});

test('the brief of a jj workspace says so and how to push', () => {
  const text = briefText({
    lane: 'r-1', path: '/wt/r-1', branch: '(detached)', repo: 'r', mainClone: '/repos/r', others: [], checks: [],
    slot: 1, lease: 'abc123', stride: 10, sparse: [], jj: { workspace: 'r-1', branch: 'feat-a' },
  });
  assert.match(text, /jj \(Jujutsu\) repo and this checkout is its workspace `r-1`/);
  assert.match(text, /jj git push -b feat-a/);
  assert.doesNotMatch(briefText({
    lane: 'r-1', path: '/wt/r-1', branch: 'main', repo: 'r', mainClone: '/repos/r', others: [], checks: [],
    slot: 1, lease: null, stride: 10, sparse: [],
  }), /Jujutsu/);
});

test('in a colocated jj repository a slot is a jj workspace from lane new to lane rm', { skip: noJj }, () => {
  const main = makeRepo('jj1');
  jj(main, 'git', 'init', '--colocate');
  const dir = capture(() => cmdNew('jj1', 'feat-a', { install: false, open: false })).result;

  assert.ok(workspaces(main).includes('jj1-1'), 'jj knows the slot');
  assert.equal(git(dir, 'branch', '--show-current'), 'feat-a');
  assert.match(locked(main, dir) ?? '', /^feat-a @ /, 'locked like any slot');
  assert.ok(samePath(jj(dir, 'workspace', 'root'), dir));

  // jj sees work done in the slot with git, and git sees jj's
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
  git(dir, 'add', 'a.txt');
  git(dir, 'commit', '-q', '-m', 'add a');
  assert.match(jj(dir, 'log', '-r', '@-', '--no-graph', '-T', 'description'), /add a/);
  assert.equal(git(dir, 'status', '--porcelain'), '', 'jj adds nothing git counts as a change (CLAUDE.local.md, .jj)');

  const [info] = (JSON.parse(capture(() => cmdList({ local: true, json: true })).out) as LaneInfo[]).filter((l) => l.repo === 'jj1');
  assert.equal(info?.jj?.workspace, 'jj1-1');
  assert.match(info?.jj?.change ?? '', /^[k-z]+$/, 'a jj change id');
  assert.match(capture(() => cmdList({ local: true })).out, /\(jj jj1-1 @ [k-z]+\)/);
  assert.match(capture(() => cmdBrief('jj1-1')).out, /its workspace `jj1-1`/);

  git(dir, 'push', '-q', 'origin', 'feat-a');
  capture(() => cmdDone('jj1-1', { force: false }));
  assert.ok(workspaces(main).includes('jj1-1'), 'a slot given back stays a workspace, ready to be taken again');

  const again = capture(() => cmdNew('jj1', 'feat-b', { install: false, open: false })).result;
  assert.ok(samePath(again, dir), 'the same slot is reused');
  assert.equal(git(again, 'branch', '--show-current'), 'feat-b');
  assert.ok(workspaces(main).includes('jj1-1'));

  assert.throws(() => cmdMove('jj1-1', { to: 'spare' }), /jj cannot move a workspace/);
  assert.throws(() => cmdNew('jj1', 'feat-c', { install: false, open: false, sparse: ['docs'] }), /sparse slots are not supported in a jj/);

  const out = capture(() => cmdRemove('jj1-1', { force: true })).out;
  assert.match(out, /and jj workspace jj1-1/);
  assert.ok(!workspaces(main).includes('jj1-1'), 'jj forgot it');
  assert.equal(fs.existsSync(dir), false);
  assert.doesNotMatch(git(main, 'worktree', 'list', '--porcelain'), /jj1-1/);
});
