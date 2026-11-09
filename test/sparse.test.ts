import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { capture, git, lane, makeRepo } from './support.ts';
import { inCone, sparseDirs } from '../src/sparse.ts';

const { cmdDone, cmdList, cmdNew } = lane;

/** A repository with three top-level folders, pushed. */
function makeTree(name: string): string {
  const main = makeRepo(name);
  const files: [string, string][] = [['app/web/index.js', 'web'], ['app/api/main.js', 'api'], ['docs/guide.md', 'guide'], ['tools/x.sh', 'x']];
  for (const [file, text] of files) {
    fs.mkdirSync(path.join(main, path.dirname(file)), { recursive: true });
    fs.writeFileSync(path.join(main, file), `${text}\n`);
  }
  git(main, 'add', '-A');
  git(main, 'commit', '-q', '-m', 'tree');
  git(main, 'push', '-q', 'origin', 'main');
  return main;
}

const has = (dir: string, file: string) => fs.existsSync(path.join(dir, file));
/** Whether git treats the checkout as sparse. */
const sparseOn = (dir: string) => {
  try {
    return git(dir, 'config', '--get', 'core.sparseCheckout') === 'true';
  } catch {
    return false;
  }
};
const newLane = (repo: string, task: string, opts: { sparse?: string[]; full?: boolean } = {}) =>
  capture(() => cmdNew(repo, task, { install: false, open: false, ...opts }));

test('sparseDirs keeps folders inside the repository, written the git way', () => {
  assert.deepEqual(sparseDirs(['app/web/', 'docs', 'app\\api', './tools', 'docs']), ['app/web', 'docs', 'app/api', 'tools']);
  for (const bad of ['../up', '/abs', 'C:/abs', 'a/../../b', '.', '', 'a/*']) assert.throws(() => sparseDirs([bad]), /--sparse/, bad);
});

test('inCone: root files, files under a chosen folder, and files of the folders above it', () => {
  const dirs = ['app/web', 'docs'];
  for (const yes of ['.env', 'app/web/.env', 'docs/a/b.md', 'app/README.md']) assert.equal(inCone(yes, dirs), true, yes);
  for (const no of ['tools/x.sh', 'app/api/.env', 'application/x']) assert.equal(inCone(no, dirs), false, no);
  assert.equal(inCone('tools/x.sh', []), true, 'no folders: everything');
});

test('lane new --sparse checks out only the chosen folders; the main clone stays whole', () => {
  const main = makeTree('sp1');
  const { result: dir, out } = newLane('sp1', 'feat-web', { sparse: ['app/web', 'docs'] });
  assert.ok(has(dir, 'app/web/index.js') && has(dir, 'docs/guide.md') && has(dir, 'base.txt'));
  assert.ok(!has(dir, 'app/api/main.js') && !has(dir, 'tools/x.sh'));
  assert.equal(git(dir, 'branch', '--show-current'), 'feat-web');
  assert.equal(git(dir, 'status', '--porcelain'), '', 'nothing looks deleted');
  assert.match(out, /sparse: app\/web, docs/);
  assert.equal(sparseOn(main), false, 'the main clone is not sparse');
  assert.equal(sparseOn(dir), true);
  assert.ok(has(main, 'tools/x.sh'), 'main clone keeps every file');
  assert.match(fs.readFileSync(path.join(dir, 'CLAUDE.local.md'), 'utf8'), /git sparse-checkout add/);
  assert.match(capture(() => cmdList({ local: true })).out, /sparse: app\/web, docs/);
});

test('a reused slot gets what the new task asks for: whole, or other folders', () => {
  makeTree('sp2');
  const dir = newLane('sp2', 'feat-a', { sparse: ['docs'] }).result;
  capture(() => cmdDone('sp2-1', { force: true }));
  const whole = newLane('sp2', 'feat-b').result;
  assert.equal(whole, dir, 'same slot');
  assert.ok(has(whole, 'tools/x.sh') && has(whole, 'app/api/main.js'), 'whole again');
  assert.equal(sparseOn(whole), false);
  capture(() => cmdDone('sp2-1', { force: true }));
  const api = newLane('sp2', 'feat-c', { sparse: ['app/api'] }).result;
  assert.ok(has(api, 'app/api/main.js') && !has(api, 'docs/guide.md'));
  assert.equal(git(api, 'branch', '--show-current'), 'feat-c');
});

test('.lanesparse sets the folders for a repository; --no-sparse takes everything', () => {
  const main = makeTree('sp3');
  fs.writeFileSync(path.join(main, '.lanesparse'), '# web work only\napp/web\n');
  fs.appendFileSync(path.join(main, '.git', 'info', 'exclude'), '.lanesparse\n');
  const dir = newLane('sp3', 'feat-a').result;
  assert.ok(has(dir, 'app/web/index.js') && !has(dir, 'docs/guide.md'));
  const full = newLane('sp3', 'feat-b', { full: true }).result;
  assert.ok(has(full, 'docs/guide.md') && has(full, 'tools/x.sh'));
  assert.throws(() => newLane('sp3', 'feat-c', { sparse: ['docs'], full: true }), /--sparse and --no-sparse/);
});

test('a folder that is not in the commit is named; local files outside the folders are not copied', () => {
  const main = makeTree('sp4');
  fs.writeFileSync(path.join(main, '.lanecopy'), 'tools/local.env\napp/web/local.env\n');
  fs.writeFileSync(path.join(main, 'tools', 'local.env'), 'T=1\n');
  fs.writeFileSync(path.join(main, 'app', 'web', 'local.env'), 'W=1\n');
  fs.mkdirSync(path.join(main, '.claude'));
  fs.writeFileSync(path.join(main, '.claude', 'settings.local.json'), '{}\n');
  fs.appendFileSync(path.join(main, '.git', 'info', 'exclude'), '.lanecopy\nlocal.env\n.claude/\n');
  const { result: dir, out } = newLane('sp4', 'feat-a', { sparse: ['app/web', 'nope'] });
  assert.match(out, /not in this commit: nope/);
  assert.ok(has(dir, 'app/web/local.env'));
  assert.ok(!has(dir, 'tools/local.env'), 'tools is a folder of the repository outside the sparse folders');
  assert.ok(has(dir, '.claude/settings.local.json'), '.claude is no folder of the repository: copied');
});
