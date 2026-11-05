import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { rmFolder } from '../src/commands.ts';

test('rmFolder really deletes a folder tree (long-path form on Windows)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lane-rm-'));
  // A path past Windows' old 260-character limit.
  let deep = dir;
  while (deep.length < 300) deep = path.join(deep, 'node_modules_xxxxxxxxxxxxxxxx');
  fs.mkdirSync(deep, { recursive: true });
  fs.writeFileSync(path.join(deep, 'f.txt'), 'x');
  rmFolder(dir);
  assert.equal(fs.existsSync(dir), false);
});
