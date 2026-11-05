import test from 'node:test';
import assert from 'node:assert/strict';
import { checkCommands, checksState, installCommands, installStamp, pickBase, repoSlug } from '../src/detect.ts';

test('pickBase prefers develop, else origin/HEAD', () => {
  assert.equal(pickBase({ hasDevelop: true, originHead: 'origin/main' }), 'develop');
  assert.equal(pickBase({ hasDevelop: false, originHead: 'origin/master' }), 'master');
  assert.throws(() => pickBase({ hasDevelop: false, originHead: '' }));
});

test('repoSlug reads https and ssh remotes', () => {
  assert.equal(repoSlug('https://github.com/vannt-dev/junto.git'), 'vannt-dev/junto');
  assert.equal(repoSlug('git@github.com:vannt-dev/aegis-net.git\n'), 'vannt-dev/aegis-net');
  assert.equal(repoSlug('https://gitlab.com/a/b.git'), null);
});

test('installCommands follows the lockfiles', () => {
  assert.deepEqual(installCommands(['pnpm-lock.yaml', 'package.json']), ['pnpm install --frozen-lockfile']);
  assert.deepEqual(installCommands(['package-lock.json']), ['npm ci --no-audit --no-fund']);
  assert.deepEqual(installCommands(['pubspec.yaml', 'pubspec.lock']), ['flutter pub get']);
  assert.deepEqual(installCommands(['README.md']), []);
});

test('installStamp changes with the lockfiles, not with their order or line ends', () => {
  const a = installStamp([{ name: 'package-lock.json', text: '{"a":1}\n' }, { name: 'pubspec.lock', text: 'x' }]);
  assert.equal(installStamp([{ name: 'pubspec.lock', text: 'x' }, { name: 'package-lock.json', text: '{"a":1}\r\n' }]), a);
  assert.notEqual(installStamp([{ name: 'package-lock.json', text: '{"a":2}\n' }, { name: 'pubspec.lock', text: 'x' }]), a);
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

test('checksState summarises a rollup', () => {
  assert.equal(checksState([]), 'none');
  assert.equal(checksState([{ conclusion: 'SUCCESS' }, { conclusion: 'SKIPPED' }]), 'pass');
  assert.equal(checksState([{ conclusion: 'SUCCESS' }, { status: 'IN_PROGRESS', conclusion: '' }]), 'pending');
  assert.equal(checksState([{ conclusion: 'FAILURE' }, { state: 'PENDING' }]), 'fail');
});
