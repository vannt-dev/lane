import test from 'node:test';
import assert from 'node:assert/strict';
import { openAgent, openPlan } from '../src/commands.ts';
import { capture } from './support.ts';

test('openPlan: Windows Terminal on Windows, tmux inside tmux, else nothing to open', () => {
  assert.deepEqual(openPlan('D:/wt/r-1', 'claude', { platform: 'win32' }), {
    program: 'wt.exe', args: ['-w', '0', 'nt', '-d', 'D:/wt/r-1', 'cmd', '/k', 'claude'], name: 'Windows Terminal',
  });
  assert.deepEqual(openPlan('/wt/r-1', 'claude', { platform: 'linux', tmux: '/tmp/tmux-1000/default,1,0' }), {
    program: 'tmux', args: ['new-window', '-c', '/wt/r-1', 'claude'], name: 'tmux',
  });
  assert.equal(openPlan('/wt/r-1', 'claude', { platform: 'darwin' }), null);
  assert.equal(openPlan('/wt/r-1', 'claude', { platform: 'linux', tmux: '' }), null);
});

test('openAgent opens nothing outside Windows and tmux, and claims nothing', () => {
  const { result, out } = capture(() => openAgent('/wt/r-1', 'claude', openPlan('/wt/r-1', 'claude', { platform: 'darwin' })));
  assert.equal(result, false);
  assert.equal(out, '');
});

test('openAgent reports success only when the terminal started', () => {
  const plan = { program: 'lane-no-such-terminal', args: [], name: 'Some Terminal' };
  const { result, out } = capture(() => openAgent('/wt/r-1', 'claude', plan));
  assert.equal(result, false);
  assert.doesNotMatch(out, /opened/);
  assert.match(out, /could not open Some Terminal/);
});
