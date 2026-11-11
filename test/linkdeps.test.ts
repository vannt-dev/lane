import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { capture, git, lane, makeRepo } from './support.ts';
import { installStamp } from '../src/detect.ts';
import { writeMeta } from '../src/meta.ts';

const { cmdNew } = lane;

const LOCK = '{"name":"x","lockfileVersion":3,"requires":true,"packages":{"":{"name":"x"}}}\n';

/** A repository with a package-lock.json, pushed. */
function makeNpmRepo(name: string, extra: Record<string, string> = {}): string {
  const main = makeRepo(name);
  const files = { 'package.json': '{"name":"x","private":true}\n', 'package-lock.json': LOCK, ...extra };
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.join(main, path.dirname(file)), { recursive: true });
    fs.writeFileSync(path.join(main, file), text);
  }
  fs.appendFileSync(path.join(main, '.gitignore'), 'node_modules/\n');
  git(main, 'add', '-A');
  git(main, 'commit', '-q', '-m', 'npm');
  git(main, 'push', '-q', 'origin', 'main');
  return main;
}

/** Gives a lane a node_modules as if npm had installed it from its lockfile. */
function fakeInstall(dir: string): void {
  const nm = path.join(dir, 'node_modules');
  fs.mkdirSync(path.join(nm, 'dep', 'lib'), { recursive: true });
  fs.writeFileSync(path.join(nm, 'dep', 'lib', 'index.js'), 'module.exports = 1;\n');
  fs.mkdirSync(path.join(nm, '.cache', 'babel'), { recursive: true });
  fs.writeFileSync(path.join(nm, '.cache', 'babel', 'x.json'), '{}');
  fs.mkdirSync(path.join(nm, '.vitest'), { recursive: true });
  fs.writeFileSync(path.join(nm, '.vitest', 'results.json'), '{}');
  fs.mkdirSync(path.join(nm, '@me'), { recursive: true });
  // a workspace link the way npm makes it on this OS: relative on POSIX, a junction elsewhere
  fs.mkdirSync(path.join(dir, 'pkgs', 'a'), { recursive: true });
  const target = process.platform === 'win32' ? path.join(dir, 'pkgs', 'a') : path.join('..', '..', 'pkgs', 'a');
  fs.symlinkSync(target, path.join(nm, '@me', 'a'), 'junction');
  const lock = fs.readFileSync(path.join(dir, 'package-lock.json'), 'utf8');
  writeMeta(dir, { installStamp: installStamp([{ name: 'package-lock.json', text: lock }]) });
}

const newLane = (repo: string, task: string, linkDeps: boolean) =>
  capture(() => cmdNew(repo, task, { install: true, open: false, linkDeps }));

test('--link-deps fills node_modules with hard links from a lane installed from the same lockfile', () => {
  makeNpmRepo('ld1', { 'pkgs/a/package.json': '{"name":"@me/a"}\n' });
  const a = newLane('ld1', 'feat-a', false);
  assert.match(a.out, /npm ci/, 'the first lane installs');
  fakeInstall(a.result);
  const b = newLane('ld1', 'feat-b', true);
  assert.match(b.out, /dependencies: linked from ld1-1 \(\d+ files, hard links\)/);
  assert.doesNotMatch(b.out, /npm ci/);
  const file = (d: string) => path.join(d, 'node_modules', 'dep', 'lib', 'index.js');
  assert.equal(fs.statSync(file(b.result)).ino, fs.statSync(file(a.result)).ino, 'same file on disk');
  for (const cache of ['.cache', '.vitest'])
    assert.ok(!fs.existsSync(path.join(b.result, 'node_modules', cache)), `${cache} is not shared`);
  const link = path.join(b.result, 'node_modules', '@me', 'a');
  assert.equal(fs.realpathSync(link), fs.realpathSync(path.join(b.result, 'pkgs', 'a')), 'workspace link points into its own lane');

  // the new lane owns its folder: removing it leaves the other lane whole
  fs.rmSync(path.join(b.result, 'node_modules'), { recursive: true, force: true });
  assert.ok(fs.existsSync(file(a.result)));
  assert.ok(fs.existsSync(path.join(a.result, 'pkgs', 'a', 'package.json')));
  assert.ok(fs.existsSync(path.join(b.result, 'pkgs', 'a', 'package.json')), 'the workspace itself is untouched');
});

test('no link copy from a lane whose lockfile changed since it installed, or when patches/ exists', () => {
  makeNpmRepo('ld2');
  const a = newLane('ld2', 'feat-a', false).result;
  fakeInstall(a);
  fs.writeFileSync(path.join(a, 'package-lock.json'), LOCK.replace('"x"}', '"x","version":"2.0.0"}'));
  const b = newLane('ld2', 'feat-b', true);
  assert.doesNotMatch(b.out, /linked from/);
  assert.match(b.out, /npm ci/);

  makeNpmRepo('ld3', { 'patches/dep+1.0.0.patch': 'diff\n' });
  fakeInstall(newLane('ld3', 'feat-a', false).result);
  const c = newLane('ld3', 'feat-b', true);
  assert.match(c.out, /not linked: patches\/ rewrites files in node_modules/);
  assert.match(c.out, /npm ci/);
});

test('nodeModulesDirs: the root folder and those of workspaces that kept their own packages', async () => {
  const { nodeModulesDirs } = await import('../src/linkdeps.ts');
  const lock = JSON.stringify({ packages: {
    '': {}, 'node_modules/a': {}, 'node_modules/a/node_modules/b': {},
    'packages/react/node_modules/vite': {}, 'packages/react/node_modules/vite/node_modules/x': {}, 'smoke/node_modules/y': {},
    'packages/core': {},
  } });
  assert.deepEqual(nodeModulesDirs(lock).sort(), ['node_modules', 'packages/react/node_modules', 'smoke/node_modules']);
  assert.deepEqual(nodeModulesDirs('not json'), ['node_modules']);
});

test('a workspace with its own node_modules gets it linked too', () => {
  const lock = JSON.stringify({ name: 'x', lockfileVersion: 3, packages: { '': {}, 'pkgs/a/node_modules/only-a': {} } });
  makeNpmRepo('ld4', { 'pkgs/a/package.json': '{"name":"@me/a"}\n', 'package-lock.json': `${lock}\n` });
  const a = newLane('ld4', 'feat-a', false).result;
  fakeInstall(a);
  fs.mkdirSync(path.join(a, 'pkgs', 'a', 'node_modules', 'only-a'), { recursive: true });
  fs.writeFileSync(path.join(a, 'pkgs', 'a', 'node_modules', 'only-a', 'index.js'), '1\n');
  const b = newLane('ld4', 'feat-b', true);
  assert.match(b.out, /linked from ld4-1 \(\d+ files, hard links, 2 node_modules folders\)/);
  assert.ok(fs.existsSync(path.join(b.result, 'pkgs', 'a', 'node_modules', 'only-a', 'index.js')));
});
