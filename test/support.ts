// Shared by the end-to-end tests: real git repositories in a temporary folder, no network.
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// Left as os.tmpdir() spells it: on GitHub's Windows runners that is an 8.3 short name
// (C:\Users\RUNNER~1\...) while git prints long paths, which lane has to match up.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lane-flow-'));
export const root = path.join(tmp, 'wt');
export const repos = path.join(tmp, 'repos');
export const remotes = path.join(tmp, 'remotes');
fs.mkdirSync(repos);
fs.mkdirSync(remotes);
process.env.LANE_ROOT = root;
process.env.LANE_REPOS = repos;
process.env.LANE_MAX_SLOTS = '3';
for (const k of ['AUTHOR', 'COMMITTER']) {
  process.env[`GIT_${k}_NAME`] = 'test';
  process.env[`GIT_${k}_EMAIL`] = 'test@example.com';
}
/** The commands, loaded after the environment above points them at the temporary folder. */
export const lane = await import('../src/index.ts');

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

export const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** A repository with an origin; `node check.js` (named in .lanecheck) fails when a.txt and b.txt meet. */
export function makeRepo(name: string): string {
  const bare = path.join(remotes, `${name}.git`);
  git(remotes, 'init', '-q', '--bare', '-b', 'main', bare);
  const dir = path.join(repos, name);
  git(repos, 'clone', '-q', bare, dir);
  fs.writeFileSync(path.join(dir, 'base.txt'), 'one\ntwo\n');
  fs.writeFileSync(
    path.join(dir, 'check.js'),
    "const fs = require('fs');\nprocess.exit(fs.existsSync('a.txt') && fs.existsSync('b.txt') ? 1 : 0);\n",
  );
  fs.writeFileSync(path.join(dir, '.gitignore'), '.lanecheck\nCLAUDE.local.md\ncache/\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init');
  git(dir, 'push', '-q', 'origin', 'main');
  git(dir, 'remote', 'set-head', 'origin', '-a');
  fs.writeFileSync(path.join(dir, '.lanecheck'), 'node check.js\n');
  return dir;
}

export function capture<T>(fn: () => T): { result: T; out: string } {
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

export const take = (repo: string, task: string) => capture(() => lane.cmdNew(repo, task, { install: false, open: false })).result;

/** A slot for a task with one committed file. */
export function laneWith(repo: string, task: string, file: string, content: string): string {
  const dir = take(repo, task);
  fs.writeFileSync(path.join(dir, file), content);
  git(dir, 'add', file);
  git(dir, 'commit', '-q', '-m', `add ${file}`);
  return dir;
}

export const locked = (main: string, slot: string) =>
  git(main, 'worktree', 'list', '--porcelain')
    .split(/\n\n/)
    .find((b) => b.includes(path.basename(slot)))
    ?.match(/^locked ?(.*)$/m)?.[1] ?? null;
