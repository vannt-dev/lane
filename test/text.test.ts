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

test('laneNotes carry the port rule only for a slot', () => {
  assert.ok(laneNotes(3).startsWith(NOTES_HEADER));
  assert.match(laneNotes(3), /This lane is slot 3/);
  assert.doesNotMatch(laneNotes(null), /slot \d/);
  assert.match(laneNotes(null), /lane done/);
});

test('briefText lists the lane, the places to stay out of, the port and the checks', () => {
  const text = briefText({
    lane: 'rk-1', path: 'F:\\wt\\rk-1', branch: 'feat/a', repo: 'rk', mainClone: 'F:\\ai\\rk',
    others: ['F:\\wt\\rk-2'], checks: ['npm run test'], slot: 1,
  });
  assert.match(text, /`F:\/wt\/rk-1`, branch `feat\/a` of rk/);
  assert.match(text, /`F:\/ai\/rk` or in the other lanes: `F:\/wt\/rk-2`\./);
  assert.match(text, /slot 1/);
  assert.match(text, /Checks to pass before you push: `npm run test`\./);
  const bare = briefText({ lane: 'x', path: '/x', branch: 'b', repo: 'r', mainClone: '/m', others: [], checks: [], slot: null });
  assert.doesNotMatch(bare, /Checks|slot \d/);
});
