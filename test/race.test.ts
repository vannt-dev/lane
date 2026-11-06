// Two sessions after the same slot: only a lock that reads back as ours is a claim.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { capture, git, lane, locked, makeRepo, root, take } from './support.ts';

// after support.ts: it points the settings at the temporary folder first
const { MainClone } = await import('../src/checkout.ts');
const { SlotPool } = await import('../src/pool.ts');
const { Detached, targetFor } = await import('../src/target.ts');

const OTHER = 'other @ 2026-11-06 10:00Z #ffffff';

/** Another session's lock lands on `dir` right after ours (git checks, then writes). */
function lockOver(main: string, dir: string): void {
  git(main, 'worktree', 'unlock', dir);
  git(main, 'worktree', 'lock', '--reason', OTHER, dir);
}

/** A main clone where another session overwrites the first lock lane takes. */
class LockRace extends MainClone {
  private raced = false;

  override tryGit(...args: string[]): string | null {
    const out = super.tryGit(...args);
    if (!this.raced && out !== null && args[0] === 'worktree' && args[1] === 'lock') {
      this.raced = true;
      lockOver(this.dir, args.at(-1) ?? '');
    }
    return out;
  }
}

/** A main clone where another session makes the new slot lane is about to make. */
class CreateRace extends MainClone {
  private raced = false;

  override git(...args: string[]): string {
    const dest = args.find((a) => a.startsWith(root));
    if (!this.raced && dest && args.includes('worktree') && args.includes('add')) {
      this.raced = true;
      super.git('worktree', 'add', '--lock', '--reason', OTHER, '--detach', dest, 'origin/main');
    }
    return super.git(...args);
  }
}

/** Slot 1 of `repo`, given back: the next take reuses it. */
function freeSlot(repo: string): string {
  const dir = take(repo, 'old');
  capture(() => lane.cmdDone(`${repo}-1`, { force: false }));
  return dir;
}

test('a lock that reads back as another session\'s is no claim: lane leaves that slot alone', () => {
  const main = makeRepo('race1');
  const first = freeSlot('race1');
  const clone = new LockRace('race1');
  const { result } = capture(() => new SlotPool(clone).take('feat-b', targetFor(clone, 'feat-b', {})));
  assert.equal(result.lane.name, 'race1-2');
  assert.equal(locked(main, first), OTHER);
  assert.equal(git(first, 'branch', '--show-current'), '', 'not switched to feat-b');
});

test('a failed switch gives the lock back only while it is still ours', () => {
  const main = makeRepo('race2');
  const first = freeSlot('race2');
  class Failing extends Detached {
    override switchIn(): void {
      throw new Error('switch failed');
    }
  }
  class Overtaken extends Detached {
    override switchIn(): void {
      lockOver(main, first);
      throw new Error('switch failed');
    }
  }
  const pool = new SlotPool(new MainClone('race2'));
  assert.throws(() => capture(() => pool.take('feat-b', new Failing('origin/main'))), /switch failed/);
  assert.equal(locked(main, first), null, 'our own lock given back');
  assert.throws(() => capture(() => pool.take('feat-c', new Overtaken('origin/main'))), /switch failed/);
  assert.equal(locked(main, first), OTHER, "another session's lock kept");
});

test('a new slot another session made first is left to it', () => {
  const main = makeRepo('race3');
  const { result } = capture(() => new SlotPool(new CreateRace('race3')).take('feat-a', new Detached('origin/main')));
  assert.equal(result.lane.name, 'race3-2');
  assert.equal(locked(main, path.join(root, 'race3-1')), OTHER);
});
