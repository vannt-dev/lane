// The slot pool of a repository: numbered worktrees, held with `git worktree lock` and reused.
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { MainClone } from './checkout.ts';
import { config, poolMax } from './config.ts';
import { Lane } from './lane.ts';
import type { Target } from './target.ts';
import { printTable } from './text.ts';
import { lockReason, parseReason, slotName } from './worktrees.ts';

/** What the choice of a slot needs to know about one. */
export interface SlotInfo {
  n: number;
  /** Lock reason; null when the slot is not locked. */
  locked: string | null;
  /** The task the slot held last (kept after it is given back). */
  lastTask?: string;
  dirty: number;
  /** Given back with `lane done` and not touched since. */
  released: boolean;
  idleMs: number;
  /** The pool the slot belongs to (`--pool`); none for the default pool. */
  pool?: string;
}

/** A slot nobody gave back is free only after this long without a change to its index. */
export const IDLE_FREE_MS = 2 * 3600_000;

type SlotChoice = { kind: 'held' | 'reuse' | 'create'; n: number } | { kind: 'full' };

/** Free = not locked, nothing uncommitted, and given back or left alone for two hours. */
const slotFree = (s: SlotInfo) => s.locked === null && s.dirty === 0 && (s.released || s.idleMs >= IDLE_FREE_MS);

/**
 * Which slot a task gets: the one already holding it, else the free slot it had last time,
 * else the lowest free slot, else a new one while the pool is under `max`. A slot locked for
 * something else is never taken. Only slots of the task's `pool` are reused or counted; a new
 * slot takes the lowest number no slot of any pool has, so ports never clash.
 */
export function pickSlot(slots: readonly SlotInfo[], task: string, max: number, pool = ''): SlotChoice {
  const held = slots.find((s) => s.locked !== null && parseReason(s.locked).task === task);
  if (held) return { kind: 'held', n: held.n };
  const mine = slots.filter((s) => (s.pool ?? '') === pool);
  const free = mine.filter(slotFree).sort((a, b) => a.n - b.n);
  const own = free.find((s) => s.lastTask === task) ?? free[0];
  if (own) return { kind: 'reuse', n: own.n };
  if (mine.length >= max) return { kind: 'full' };
  let n = 1;
  while (slots.some((s) => s.n === n)) n++;
  return { kind: 'create', n };
}

export class SlotPool {
  readonly clone: MainClone;

  constructor(clone: MainClone) {
    this.clone = clone;
  }

  /** The slots of the repository (its lanes with a slot number). */
  slots(): Lane[] {
    return Lane.of(this.clone).filter((l) => l.slot !== null);
  }

  /** The slot already held for `task`, if any: checked before a branch is chosen for it. */
  heldFor(task: string): string | undefined {
    const choice = pickSlot(this.slots().map((l) => this.info(l)), task, Infinity);
    return choice.kind === 'held' ? slotName(this.clone.name, choice.n) : undefined;
  }

  private info(l: Lane): SlotInfo {
    const n = l.slot ?? 0;
    if (!l.exists) return { n, locked: l.locked ?? '(folder missing)', dirty: 0, released: false, idleMs: 0 };
    const m = l.meta();
    return { n, locked: l.locked, lastTask: m.task, dirty: l.dirty(), released: l.released(), idleMs: l.idleMs(), pool: m.pool };
  }

  print(slots: readonly Lane[]): void {
    printTable(['slot', 'state', 'branch', 'uncommitted'], slots.map((l) => [
      l.name, l.stateText(), l.branch || '(detached)', String(l.exists ? l.dirty() : 0),
    ]));
  }

  /**
   * Takes a slot for `task`, locks it and puts it on the target. A full pool prints who holds
   * what and refuses. The claim is a lock read back with this hold's lease: when another
   * session locked or made the chosen slot first, lane leaves it alone and looks again.
   * `dirs` limits the slot to those folders (sparse); none gives it every file. `pool` keeps
   * the slot apart from the other pools (see pickSlot).
   */
  take(task: string, target: Target, dirs: readonly string[] = [], pool = ''): { lane: Lane; reused: boolean } {
    const max = poolMax(pool);
    for (let attempt = 0; attempt < 3; attempt++) {
      const slots = this.slots();
      const infos = slots.map((l) => this.info(l));
      const choice = pickSlot(infos, task, max, pool);
      if (choice.kind === 'held') throw new Error(`${task} already holds ${slotName(this.clone.name, choice.n)}`);
      if (choice.kind === 'full') {
        this.print(slots.filter((_, i) => (infos[i]?.pool ?? '') === pool));
        const raise = pool ? `raise it in LANE_POOLS (${pool}=<n>)` : 'raise LANE_MAX_SLOTS';
        throw new Error(`all ${max} slots of ${this.clone.name}${pool ? ` in pool ${pool}` : ''} are in use. lane never takes ` +
          `a slot held for something else: give one back (lane done) once its work is pushed, or ${raise}`);
      }
      const dest = path.join(config.root, slotName(this.clone.name, choice.n));
      const lease = randomBytes(3).toString('hex');
      const reason = lockReason(task, new Date(), lease);
      const locked = choice.kind === 'create'
        ? this.create(choice.n, dest, reason, target, dirs)
        : this.clone.tryGit('worktree', 'lock', '--reason', reason, dest) !== null;
      const mine = locked ? this.heldUnder(choice.n, lease) : undefined;
      if (!mine) continue;
      if (choice.kind === 'reuse') this.switchOrUnlock(mine, lease, target, dirs);
      const lane = this.slots().find((l) => l.slot === choice.n) ?? mine;
      lane.setMeta({ task, lease, start: lane.git('rev-parse', 'HEAD'), released: false, ...(pool ? { pool } : {}) });
      return { lane, reused: choice.kind === 'reuse' };
    }
    throw new Error(`could not lock a slot of ${this.clone.name}; another session keeps taking them, try again`);
  }

  /** Slot `n` as git lists it now, when its lock carries `lease`. */
  private heldUnder(n: number, lease: string): Lane | undefined {
    return this.slots().find((l) => l.slot === n && l.lease() === lease);
  }

  /** A new slot, locked from its first moment; false when another session made it first. */
  private create(n: number, dest: string, reason: string, target: Target, dirs: readonly string[]): boolean {
    try {
      this.clearFolder(dest);
      target.add(this.clone, dest, reason, dirs);
      return true;
    } catch (e) {
      if (this.slots().some((l) => l.slot === n)) return false;
      throw e;
    }
  }

  /** A new slot's folder must not exist, or be an empty leftover. */
  private clearFolder(dest: string): void {
    fs.mkdirSync(config.root, { recursive: true });
    if (!fs.existsSync(dest)) return;
    if (fs.readdirSync(dest).length > 0) throw new Error(`${dest} exists but is no worktree of ${this.clone.name}; move it away`);
    fs.rmdirSync(dest);
  }

  /** Moves a reused slot to the target; on failure gives the lock back, only if still ours. */
  private switchOrUnlock(slot: Lane, lease: string, target: Target, dirs: readonly string[]): void {
    try {
      target.switchIn(slot, dirs);
    } catch (e) {
      if (slot.slot !== null && this.heldUnder(slot.slot, lease)) this.clone.tryGit('worktree', 'unlock', slot.dir);
      throw e;
    }
  }
}
