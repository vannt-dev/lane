// End-to-end: real git repositories in a temporary folder, no network, no GitHub.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// Left as os.tmpdir() spells it: on GitHub's Windows runners that is an 8.3 short name
// (C:\Users\RUNNER~1\...) while git prints long paths, which lane has to match up.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lane-flow-'));
const root = path.join(tmp, 'wt');
const repos = path.join(tmp, 'repos');
const remotes = path.join(tmp, 'remotes');
fs.mkdirSync(repos);
fs.mkdirSync(remotes);
process.env.LANE_ROOT = root;
process.env.LANE_REPOS = repos;
for (const k of ['AUTHOR', 'COMMITTER']) {
  process.env[`GIT_${k}_NAME`] = 'test';
  process.env[`GIT_${k}_EMAIL`] = 'test@example.com';
}
const { cmdBrief, cmdNew, cmdSync, cmdVerify } = await import('../src/commands.ts');

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** A repository with an origin; `node check.js` (named in .lanecheck) fails when a.txt and b.txt meet. */
function makeRepo(name: string): string {
  const bare = path.join(remotes, `${name}.git`);
  git(remotes, 'init', '-q', '--bare', '-b', 'main', bare);
  const dir = path.join(repos, name);
  git(repos, 'clone', '-q', bare, dir);
  fs.writeFileSync(path.join(dir, 'base.txt'), 'one\ntwo\n');
  fs.writeFileSync(
    path.join(dir, 'check.js'),
    "const fs = require('fs');\nprocess.exit(fs.existsSync('a.txt') && fs.existsSync('b.txt') ? 1 : 0);\n",
  );
  fs.writeFileSync(path.join(dir, '.gitignore'), '.lanecheck\nCLAUDE.local.md\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init');
  git(dir, 'push', '-q', 'origin', 'main');
  git(dir, 'remote', 'set-head', 'origin', '-a');
  fs.writeFileSync(path.join(dir, '.lanecheck'), 'node check.js\n');
  return dir;
}

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

function laneWith(repo: string, task: string, file: string, content: string): string {
  capture(() => cmdNew(repo, task, { install: false, open: false }));
  const dir = path.join(root, `${repo}-${task}`);
  fs.writeFileSync(path.join(dir, file), content);
  git(dir, 'add', file);
  git(dir, 'commit', '-q', '-m', `add ${file}`);
  return dir;
}

function capture<T>(fn: () => T): { result: T; out: string } {
  const lines: string[] = [];
  const log = console.log;
  const write = process.stdout.write.bind(process.stdout);
  console.log = (...a: unknown[]) => void lines.push(a.join(' '));
  process.stdout.write = ((s: string) => (lines.push(String(s)), true)) as typeof process.stdout.write;
  try {
    return { result: fn(), out: lines.join('\n') };
  } finally {
    console.log = log;
    process.stdout.write = write;
  }
}

test('verify passes one lane and removes its throwaway checkout', () => {
  makeRepo('one');
  laneWith('one', 'feat-a', 'a.txt', 'a\n');
  const { result, out } = capture(() => cmdVerify('one', { keep: false }));
  assert.equal(result, 0, out);
  assert.match(out, /checks pass/);
  assert.equal(fs.existsSync(path.join(root, 'one-verify')), false);
});

test('verify finds lanes that merge cleanly but break each other', () => {
  makeRepo('two');
  laneWith('two', 'feat-a', 'a.txt', 'a\n');
  laneWith('two', 'feat-b', 'b.txt', 'b\n');
  const { result, out } = capture(() => cmdVerify('two', { keep: false }));
  assert.equal(result, 1, out);
  assert.match(out, /FAILS/);
  assert.equal(fs.existsSync(path.join(root, 'two-verify')), true, 'kept to look at');
});

test('verify reports a text conflict and still checks the rest', () => {
  makeRepo('three');
  laneWith('three', 'feat-c', 'base.txt', 'one\nC\n');
  laneWith('three', 'feat-d', 'base.txt', 'one\nD\n');
  const { result, out } = capture(() => cmdVerify('three', { keep: false }));
  assert.equal(result, 1, out);
  assert.match(out, /CONFLICT with feat-c: base\.txt/);
});

test('sync rebases a lane onto the moved base and runs its checks', () => {
  const main = makeRepo('four');
  const lane = laneWith('four', 'feat-e', 'e.txt', 'e\n');
  fs.writeFileSync(path.join(main, 'merged.txt'), 'from another lane\n');
  git(main, 'add', 'merged.txt');
  git(main, 'commit', '-q', '-m', 'another lane merged');
  git(main, 'push', '-q', 'origin', 'main');
  const { result, out } = capture(() => cmdSync('four', { push: false }));
  assert.equal(result, 0, out);
  assert.match(out, /rebased, checks pass/);
  assert.equal(fs.existsSync(path.join(lane, 'merged.txt')), true);
  assert.equal(git(lane, 'log', '-1', '--format=%s'), 'add e.txt');
});

test('sync leaves a conflicting lane as it was', () => {
  const main = makeRepo('five');
  const lane = laneWith('five', 'feat-f', 'base.txt', 'one\nF\n');
  const before = git(lane, 'rev-parse', 'HEAD');
  fs.writeFileSync(path.join(main, 'base.txt'), 'one\nMAIN\n');
  git(main, 'commit', '-q', '-am', 'main changed the same line');
  git(main, 'push', '-q', 'origin', 'main');
  const { result, out } = capture(() => cmdSync('five', { push: false }));
  assert.equal(result, 1, out);
  assert.match(out, /CONFLICT, left as it was: base\.txt/);
  assert.equal(git(lane, 'rev-parse', 'HEAD'), before);
  assert.equal(git(lane, 'status', '--porcelain'), '');
});

test('a new lane wraps the pre-push hook so it waits for a build slot', () => {
  const main = makeRepo('six');
  fs.writeFileSync(path.join(main, '.git', 'hooks', 'pre-push'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(main, '.git', 'hooks', 'commit-msg'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  capture(() => cmdNew('six', 'feat-g', { install: false, open: false }));
  const lane = path.join(root, 'six-feat-g');
  const hooksPath = git(lane, 'config', '--worktree', 'core.hooksPath');
  assert.match(fs.readFileSync(path.join(hooksPath, 'pre-push'), 'utf8'), /exec lane with build -- sh ".*pre-push" "\$@"/);
  assert.doesNotMatch(fs.readFileSync(path.join(hooksPath, 'commit-msg'), 'utf8'), /lane with/);
  assert.throws(() => git(main, 'config', '--worktree', 'core.hooksPath'), 'the main clone keeps its own hooks');
});

test('brief names the lane, its branch and the lanes to keep out of', () => {
  makeRepo('seven');
  laneWith('seven', 'feat-h', 'h.txt', 'h\n');
  laneWith('seven', 'feat-i', 'i.txt', 'i\n');
  const { out } = capture(() => cmdBrief('seven-feat-h'));
  // The brief prints paths as git does (long form), so compare with the real path.
  const p = (s: string) => fs.realpathSync.native(s).replace(/\\/g, '/');
  assert.match(out, /branch `feat-h`/);
  assert.ok(out.includes(p(path.join(root, 'seven-feat-h'))));
  assert.ok(out.includes(p(path.join(root, 'seven-feat-i'))));
  assert.match(out, /`node check\.js`/);
});
