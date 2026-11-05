import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Locks, isStale, runArgv } from '../src/locks.ts';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lane-locks-'));

test('isStale: pid locks follow the process, claim locks follow the lane and age', () => {
  const base = { maxAgeMs: 1000, laneExists: () => true };
  assert.equal(isStale({ lane: 'a', since: 0, pid: 1 }, { ...base, alive: () => true }), false);
  assert.equal(isStale({ lane: 'a', since: 0, pid: 1 }, { ...base, alive: () => false }), true);
  assert.equal(isStale({ lane: 'a', lanePath: 'x', since: 0 }, { ...base, now: 500 }), false);
  assert.equal(isStale({ lane: 'a', lanePath: 'x', since: 0 }, { ...base, now: 5000 }), true);
  assert.equal(isStale({ lane: 'a', lanePath: 'x', since: 0 }, { ...base, now: 1, laneExists: () => false }), true);
});

test('a claim blocks a second lane until released', () => {
  const root = tmp();
  const lanePath = fs.mkdtempSync(path.join(root, 'lane-'));
  const locks = new Locks(root);
  assert.equal(locks.tryTake('emulator', { lane: 'a', lanePath }), null);
  assert.equal(locks.tryTake('emulator', { lane: 'b', lanePath })?.lane, 'a');
  assert.throws(() => locks.take('emulator', { lane: 'b', lanePath }, { wait: false }), /held by a/);
  assert.throws(() => locks.release('emulator', 'b'), /held by a/);
  assert.ok(locks.release('emulator', 'a'));
  assert.equal(locks.tryTake('emulator', { lane: 'b', lanePath }), null);
});

test('a claim whose lane folder is gone is taken over', () => {
  const root = tmp();
  const locks = new Locks(root);
  locks.tryTake('emulator', { lane: 'old', lanePath: path.join(root, 'gone') });
  assert.equal(locks.tryTake('emulator', { lane: 'new', lanePath: root }), null);
  assert.equal(locks.read('emulator')?.lane, 'new');
});

test('withSlot runs the command and frees the slot', () => {
  const root = tmp();
  const locks = new Locks(root);
  const status = locks.withSlot('build', 2, { lane: 'a' }, ['node -e "process.exit(3)"'], { say: () => {} });
  assert.equal(status, 3);
  assert.deepEqual(locks.list(), []);
});

test('withSlot uses the second slot when the first is busy', () => {
  const root = tmp();
  const locks = new Locks(root);
  locks.tryTake('build-1', { lane: 'busy', pid: process.pid });
  const marker = path.join(root, 'seen.txt');
  const cmd = `node -e "require('fs').writeFileSync(process.argv[1], require('fs').readdirSync(process.argv[2]).join(','))" "${marker}" "${path.join(root, '.locks')}"`;
  assert.equal(locks.withSlot('build', 2, { lane: 'a' }, [cmd], { say: () => {} }), 0);
  assert.equal(fs.readFileSync(marker, 'utf8'), 'build-1.json,build-2.json');
  assert.deepEqual(locks.list().map((l) => l.name), ['build-1']);
});

test('runArgv keeps shell characters literal when given separate arguments', () => {
  assert.equal(runArgv(['node', '-e', 'process.exit(process.argv[1] === "a>b&c" ? 5 : 6)', 'a>b&c']), 5);
});

test('an unreadable fresh lock file counts as busy, not stale', () => {
  const root = tmp();
  const locks = new Locks(root);
  fs.mkdirSync(path.join(root, '.locks'));
  fs.writeFileSync(path.join(root, '.locks', 'emulator.json'), '');
  assert.equal(locks.tryTake('emulator', { lane: 'a', lanePath: root })?.lane, '?');
});
