import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  slug, lanePath, pickBase, installCommands, parseWorktrees, samePath, isInside,
  checksState, cleanable, repoSlug, listLines, checkCommands, hookWrapper, briefText,
} from '../src/core.ts';

test('listLines drops blanks and comments', () => {
  assert.deepEqual(listLines('# checks\nnpm test\r\n\n  node x.js  \n'), ['npm test', 'node x.js']);
});

test('checkCommands: custom first, else what the checkout has', () => {
  assert.deepEqual(checkCommands({ files: ['package.json'], scripts: { test: 'x' }, custom: ['make check'] }), ['make check']);
  assert.deepEqual(
    checkCommands({ files: ['package.json', 'pnpm-lock.yaml'], scripts: { build: 'b', test: 't', typecheck: 'c' } }),
    ['pnpm run typecheck', 'pnpm run test'],
  );
  assert.deepEqual(checkCommands({ files: ['package.json'], scripts: { lint: 'l' } }), ['npm run lint']);
  assert.deepEqual(checkCommands({ files: ['pubspec.yaml', 'Cargo.toml'] }), ['flutter analyze', 'flutter test', 'cargo test']);
  assert.deepEqual(checkCommands({ files: ['README.md'] }), []);
});

test('hookWrapper sends only heavy hooks through a build slot', () => {
  assert.match(hookWrapper('pre-push', 'C:\\r\\.git\\hooks\\pre-push'), /exec lane with build -- sh "C:\/r\/\.git\/hooks\/pre-push" "\$@"/);
  assert.match(hookWrapper('commit-msg', '/r/.git/hooks/commit-msg'), /^#!\/bin\/sh\n.*\nexec "\/r\/\.git\/hooks\/commit-msg" "\$@"\n$/);
});

test('briefText lists the lane, the places to stay out of and the checks', () => {
  const text = briefText({
    lane: 'rk-a', path: 'F:\\wt\\rk-a', branch: 'feat/a', repo: 'rk', mainClone: 'F:\\ai\\rk',
    others: ['F:\\wt\\rk-b'], checks: ['npm run test'],
  });
  assert.match(text, /`F:\/wt\/rk-a`, branch `feat\/a` of rk/);
  assert.match(text, /`F:\/ai\/rk` or in the other lanes: `F:\/wt\/rk-b`\./);
  assert.match(text, /Checks to pass before you push: `npm run test`\./);
  assert.doesNotMatch(briefText({ lane: 'x', path: '/x', branch: 'b', repo: 'r', mainClone: '/m', others: [], checks: [] }), /Checks/);
});

test('slug makes folder-safe names', () => {
  assert.equal(slug('fix/login bug'), 'fix-login-bug');
  assert.equal(slug('  Feat/ÄBC--x '), 'feat-bc-x');
});

test('lanePath joins root, repo and slug', () => {
  assert.equal(lanePath('F:/wt', 'junto', 'feat/x'), path.join('F:/wt', 'junto-feat-x'));
});

test('pickBase prefers develop, else origin/HEAD', () => {
  assert.equal(pickBase({ hasDevelop: true, originHead: 'origin/main' }), 'develop');
  assert.equal(pickBase({ hasDevelop: false, originHead: 'origin/master' }), 'master');
  assert.throws(() => pickBase({ hasDevelop: false, originHead: '' }));
});

test('installCommands follows the lockfiles', () => {
  assert.deepEqual(installCommands(['pnpm-lock.yaml', 'package.json']), ['pnpm install --frozen-lockfile']);
  assert.deepEqual(installCommands(['package-lock.json']), ['npm ci --no-audit --no-fund']);
  assert.deepEqual(installCommands(['pubspec.yaml', 'pubspec.lock']), ['flutter pub get']);
  assert.deepEqual(installCommands(['README.md']), []);
});

test('parseWorktrees reads porcelain output', () => {
  const text = [
    'worktree F:/ai-agent/junto', 'HEAD abc', 'branch refs/heads/main', '',
    'worktree F:/wt/junto-x', 'HEAD def', 'branch refs/heads/feat/x', '',
    'worktree F:/wt/junto-y', 'HEAD 123', 'detached', '',
  ].join('\n');
  const w = parseWorktrees(text);
  assert.equal(w.length, 3);
  assert.equal(w[1]?.branch, 'feat/x');
  assert.equal(w[2]?.detached, true);
});

test('path helpers ignore case and slash style (Windows)', { skip: process.platform !== 'win32' }, () => {
  assert.ok(samePath('F:/wt/a', 'f:\\WT\\a\\'));
  assert.ok(isInside('F:/wt/junto-x', 'F:\\wt'));
  assert.ok(!isInside('F:/wtx/a', 'F:/wt'));
});

test('path helpers compare whole folder names', () => {
  const root = path.resolve('wt');
  assert.ok(samePath(path.join(root, 'a'), path.join(root, 'a') + path.sep));
  assert.ok(isInside(path.join(root, 'junto-x'), root));
  assert.ok(!isInside(path.resolve('wtx', 'a'), root));
});

test('checksState summarises a rollup', () => {
  assert.equal(checksState([]), 'none');
  assert.equal(checksState([{ conclusion: 'SUCCESS' }, { conclusion: 'SKIPPED' }]), 'pass');
  assert.equal(checksState([{ conclusion: 'SUCCESS' }, { status: 'IN_PROGRESS', conclusion: '' }]), 'pending');
  assert.equal(checksState([{ conclusion: 'FAILURE' }, { state: 'PENDING' }]), 'fail');
});

test('cleanable needs a merged PR and a clean, pushed tree', () => {
  assert.ok(cleanable({ prState: 'MERGED', dirty: 0, unpushed: false }));
  assert.ok(!cleanable({ prState: 'MERGED', dirty: 2, unpushed: false }));
  assert.ok(!cleanable({ prState: 'OPEN', dirty: 0, unpushed: false }));
  assert.ok(!cleanable({ prState: 'MERGED', dirty: 0, unpushed: true }));
});

test('cleanable accepts a squash-merged lane still on the merged commit', () => {
  assert.ok(cleanable({ prState: 'MERGED', dirty: 0, unpushed: true, atPrHead: true }));
  assert.ok(!cleanable({ prState: 'MERGED', dirty: 0, unpushed: true, atPrHead: false }));
  assert.ok(!cleanable({ prState: 'MERGED', dirty: 1, unpushed: true, atPrHead: true }));
  assert.ok(!cleanable({ prState: 'OPEN', dirty: 0, unpushed: true, atPrHead: true }));
});

test('repoSlug reads https and ssh remotes', () => {
  assert.equal(repoSlug('https://github.com/vannt-dev/junto.git'), 'vannt-dev/junto');
  assert.equal(repoSlug('git@github.com:vannt-dev/aegis-net.git\n'), 'vannt-dev/aegis-net');
  assert.equal(repoSlug('https://gitlab.com/a/b.git'), null);
});
