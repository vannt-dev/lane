// Moving a slot between the lane root and the spare one: when a drive fills up, or has room again.
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.ts';
import { findLane } from './find.ts';
import { disk, rmLaneFolder, rootIndex, samePath } from './fsutil.ts';
import { Lane } from './lane.ts';
import { writeMeta } from './meta.ts';
import { LaneSetup } from './setup.ts';
import { currentDirs } from './sparse.ts';
import { Detached, LocalBranch } from './target.ts';
import { log } from './text.ts';
import { lockReason } from './worktrees.ts';

const ROOTS = ['main', 'spare'];
const label = (i: number) => (i === 0 ? 'the lane root' : 'the spare root');

/**
 * Moves a slot to the lane root (`main`) or the spare one. On one drive git moves the folder as
 * it is. Across drives the slot is made again there (same branch or commit, sparse folders,
 * hold, pool) and the old folder deleted: dependencies and build caches stay behind, so a slot
 * with uncommitted or unpushed work is refused. A held slot moves for its holder only (`lease`);
 * a free one is locked for the move, then left free.
 */
export function cmdMove(name: string, opts: { to: string; lease?: string }): void {
  const to = ROOTS.indexOf(opts.to);
  if (to < 0) throw new Error(`--to takes main or spare: "${opts.to}" is neither`);
  const lane = findLane(name);
  const ws = lane.jjWorkspace();
  if (ws) throw new Error(`${name} is jj workspace ${ws.name}, and jj cannot move a workspace: lane rm ${name}, then lane new`);
  const destRoot = config.roots[to];
  if (destRoot === undefined) throw new Error('no spare root: set LANE_ROOT_SPARE to a folder on another drive');
  if (rootIndex(lane.dir) === to) throw new Error(`${name} is already on ${label(to)} (${destRoot})`);
  const free = disk.freeGb(destRoot);
  if (free !== null && free < config.minFreeGb)
    throw new Error(`${destRoot} has ${free.toFixed(1)} GB free, under ${config.minFreeGb} GB (LANE_MIN_FREE_GB)`);
  const hold = holdFor(lane, opts.lease);
  try {
    const users = hold.slot.inUse();
    if (users.length > 0) throw new Error(`${name} is in use (${users.join(', ')}); stop that first`);
    const dest = path.join(destRoot, hold.slot.name);
    clearDest(dest);
    const note = disk.sameDrive(hold.slot.dir, destRoot) ? rename(hold.slot, dest) : remake(hold.slot, dest, hold.temporary);
    log(`moved ${name} to ${dest}${note}`);
  } finally {
    if (hold.temporary) {
      const now = Lane.of(lane.clone).find((l) => l.lease() === hold.lease);
      if (now) lane.clone.tryGit('worktree', 'unlock', now.dir);
    }
  }
}

/**
 * The hold the slot keeps through the move. A held slot: its own, when `lease` is the hold's.
 * A free slot: a lock taken for the move only (`temporary`), read back so a session that took
 * the slot meanwhile keeps it.
 */
function holdFor(lane: Lane, lease?: string): { slot: Lane; lease: string; temporary: boolean } {
  if (lane.locked !== null) {
    const own = lane.lease();
    if (!lease || lease !== own) {
      throw new Error(`${lane.name} is held for ${lane.task()}; only its holder moves it: ` +
        `lane move ${lane.name} --to <main|spare> --lease <the hold's lease>`);
    }
    return { slot: lane, lease, temporary: false };
  }
  const mine = randomBytes(3).toString('hex');
  lane.clone.tryGit('worktree', 'lock', '--reason', lockReason('moving', new Date(), mine), lane.dir);
  const slot = Lane.of(lane.clone).find((l) => l.name === lane.name && l.lease() === mine);
  if (!slot) throw new Error(`${lane.name} was taken by another session meanwhile; nothing moved`);
  return { slot, lease: mine, temporary: true };
}

/** The folder a slot moves to must not exist, or be an empty leftover. */
function clearDest(dest: string): void {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (!fs.existsSync(dest)) return;
  if (fs.readdirSync(dest).length > 0) throw new Error(`${dest} exists and is not empty; move it away first`);
  fs.rmdirSync(dest);
}

/** On one drive: git moves the folder with everything in it (`--force` twice: the slot is locked). */
function rename(slot: Lane, dest: string): string {
  slot.clone.git('worktree', 'move', '--force', '--force', slot.dir, dest);
  return '';
}

/**
 * Across drives: the slot is removed and added again at `dest` under the same lock, on its
 * branch (or commit), limited to the same folders. Its lane.json goes along, but not the
 * install stamp: the dependencies did not move. A held slot is set up again for its holder.
 */
function remake(slot: Lane, dest: string, free: boolean): string {
  if (slot.dirty() > 0 || (slot.branch && slot.ahead() > 0)) {
    throw new Error(`${slot.name} has uncommitted or unpushed work; across drives the slot is made again, ` +
      'so commit and push it first');
  }
  const dirs = currentDirs(slot);
  const meta = { ...slot.meta(), installStamp: undefined };
  const target = slot.branch ? new LocalBranch(slot.branch) : new Detached(slot.wt.head);
  if (slot.clone.tryGit('worktree', 'remove', '--force', '--force', slot.dir) === null) {
    slot.clone.tryGit('worktree', 'unlock', slot.dir);
  }
  if (fs.existsSync(slot.dir) && !rmLaneFolder(slot.dir)) throw new Error(`could not delete ${slot.dir}; nothing was made at ${dest}`);
  slot.clone.tryGit('worktree', 'prune');
  target.add(slot.clone, dest, slot.locked ?? '', dirs);
  writeMeta(dest, meta.released ? { ...meta, releasedAt: Date.now() } : meta);
  if (free) return ' (made again there: dependencies and build caches stayed behind; the next lane new installs them)';
  const moved = Lane.of(slot.clone).find((l) => samePath(l.dir, dest));
  if (moved) new LaneSetup(moved).run({ install: true });
  return ' (made again there and set up)';
}

/** For `lane list`: slots on the spare root, once the lane root's drive has room again. */
export function spareHint(lanes: readonly { name: string; path: string; state: string }[]): void {
  const [root, spare] = config.roots;
  if (root === undefined || spare === undefined) return;
  const free = disk.freeGb(root);
  if (free === null || free < config.minFreeGb) return;
  for (const l of lanes.filter((x) => rootIndex(x.path) === 1)) {
    const lease = l.state === 'held' ? ' --lease <the hold\'s lease> (its holder)' : '';
    log(`note: ${l.name} is on the spare root; ${root} has ${free.toFixed(0)} GB free again: lane move ${l.name} --to main${lease}`);
  }
}
