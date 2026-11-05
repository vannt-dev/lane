import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { capture, git, lane, laneWith, makeRepo, take } from './support.ts';

const { cmdBrief } = lane;

test('a new lane wraps the pre-push hook so it waits for a build slot', () => {
  const main = makeRepo('thirteen');
  fs.writeFileSync(path.join(main, '.git', 'hooks', 'pre-push'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(main, '.git', 'hooks', 'commit-msg'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const lane = take('thirteen', 'feat-g');
  const hooksPath = git(lane, 'config', '--worktree', 'core.hooksPath');
  assert.match(fs.readFileSync(path.join(hooksPath, 'pre-push'), 'utf8'), /exec lane with build -- sh ".*pre-push" "\$@"/);
  assert.doesNotMatch(fs.readFileSync(path.join(hooksPath, 'commit-msg'), 'utf8'), /lane with/);
  assert.throws(() => git(main, 'config', '--worktree', 'core.hooksPath'), 'the main clone keeps its own hooks');
});

test('brief names the lane, its branch, its port and the lanes to keep out of', () => {
  makeRepo('fourteen');
  const h = laneWith('fourteen', 'feat-h', 'h.txt', 'h\n');
  const i = laneWith('fourteen', 'feat-i', 'i.txt', 'i\n');
  const { out } = capture(() => cmdBrief(path.basename(h)));
  // the brief prints paths as git does (long form), so compare with the real path
  const p = (s: string) => fs.realpathSync.native(s).replace(/\\/g, '/');
  assert.match(out, /branch `feat-h`/);
  assert.ok(out.includes(p(h)));
  assert.ok(out.includes(p(i)));
  assert.match(out, /`node check\.js`/);
  assert.match(out, /slot 1/);
  assert.match(out, /lane done/);
});
