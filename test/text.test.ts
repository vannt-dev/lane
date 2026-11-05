import test from 'node:test';
import assert from 'node:assert/strict';
import { briefText, hookWrapper, laneNotes, listLines, NOTES_HEADER } from '../src/text.ts';

test('listLines drops blanks and comments', () => {
  assert.deepEqual(listLines('# checks\nnpm test\r\n\n  node x.js  \n'), ['npm test', 'node x.js']);
});

test('hookWrapper sends only heavy hooks through a build slot', () => {
  assert.match(hookWrapper('pre-push', 'C:\\r\\.git\\hooks\\pre-push', true), /exec lane with build -- sh "C:\/r\/\.git\/hooks\/pre-push" "\$@"/);
  assert.match(hookWrapper('commit-msg', '/r/.git/hooks/commit-msg', false), /^#!\/bin\/sh\n.*\nexec "\/r\/\.git\/hooks\/commit-msg" "\$@"\n$/);
});

test('laneNotes carry the port range and the lease only for a slot hold', () => {
  const held = laneNotes({ slot: 3, lease: 'a1b2c3', stride: 10 });
  assert.ok(held.startsWith(NOTES_HEADER));
  assert.match(held, /slot 3: its ports are the usual port \+ 30 to \+ 39/);
  assert.match(held, /`lane port <its usual port> \[0-9\]`/);
  assert.match(held, /`lane done --lease a1b2c3`/);
  const bare = laneNotes({ slot: null, lease: null, stride: 10 });
  assert.doesNotMatch(bare, /slot \d|--lease/);
  assert.match(bare, /`lane done`/);
});

test('briefText lists the lane, the places to stay out of, the ports, the checks and the lease', () => {
  const text = briefText({
    lane: 'rk-1', path: 'F:\\wt\\rk-1', branch: 'feat/a', repo: 'rk', mainClone: 'F:\\ai\\rk',
    others: ['F:\\wt\\rk-2'], checks: ['npm run test'], slot: 1, lease: 'ff00aa', stride: 5,
  });
  assert.match(text, /`F:\/wt\/rk-1`, branch `feat\/a` of rk/);
  assert.match(text, /`F:\/ai\/rk` or in the other lanes: `F:\/wt\/rk-2`\./);
  assert.match(text, /slot 1: its ports are the usual port \+ 5 to \+ 9/);
  assert.match(text, /Checks to pass before you push: `npm run test`\./);
  assert.match(text, /lane done --lease ff00aa/);
  const bare = briefText({ lane: 'x', path: '/x', branch: 'b', repo: 'r', mainClone: '/m', others: [], checks: [], slot: null, lease: null, stride: 10 });
  assert.doesNotMatch(bare, /Checks|slot \d/);
});
