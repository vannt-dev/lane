// A lane: a worktree of a main clone under the lane root, usually a numbered pool slot.
import fs from 'node:fs';
import path from 'node:path';
import { locks } from './checks.ts';
import { Checkout, MainClone } from './checkout.ts';
import { rmLaneFolder, samePath, underRoot } from './fsutil.ts';
import { prFor, type Pr } from './github.ts';
import { mergedInto } from './merged.ts';
import { readMeta, writeMeta, type SlotMeta } from './meta.ts';
import { holdAbandoned, processesUsing } from './stale.ts';
import { age, parseReason, slotNumber, workSafe, type Worktree } from './worktrees.ts';

/**
 * A lane's hold. `held`: locked for `task`; `free`: given back with `lane done` (`task` is the
 * last one); `unlocked`: not locked, yet changed since it was given back; `missing`: no folder.
 */
export interface LaneState {
  state: 'held' | 'free' | 'unlocked' | 'missing';
  task: string | null;
  lease: string | null;
  /** When the hold began (ms since 1970), when the lock reason says. */
  since: number | null;
  abandoned: boolean;
  /** Time since anything changed the slot's index; null when it cannot be read. */
  idleMs: number | null;
}

/** A lane's state in words, for a table or a message. */
export function stateText(s: Pick<LaneState, 'state' | 'task' | 'since' | 'abandoned' | 'idleMs'>): string {
  const idle = age(s.idleMs ?? Number.POSITIVE_INFINITY);
  if (s.state === 'held') {
    const left = s.abandoned ? `, looks abandoned (unchanged ${idle}, no process)` : '';
    return `held: ${s.task}${s.since ? `, ${age(Date.now() - s.since)}` : ''}${left}`;
  }
  if (s.state === 'missing') return 'folder missing';
  if (s.state === 'free') return `free (last: ${s.task ?? '?'})`;
  return `not locked, changed ${idle} ago`;
}

export class Lane extends Checkout {
  readonly clone: MainClone;
  readonly wt: Worktree;
  readonly name: string;
  /** The slot number, or null for a lane folder named otherwise. */
  readonly slot: number | null;

  constructor(clone: MainClone, wt: Worktree) {
    super(wt.path);
    this.clone = clone;
    this.wt = wt;
    this.name = path.basename(wt.path);
    this.slot = slotNumber(this.name, clone.name);
  }

  static of(clone: MainClone): Lane[] {
    return clone.worktrees().filter((w) => underRoot(w.path)).map((w) => new Lane(clone, w));
  }

  static all(): Lane[] {
    return MainClone.all().flatMap((c) => Lane.of(c));
  }

  get branch(): string {
    return this.wt.branch;
  }

  get locked(): string | null {
    return this.wt.locked;
  }

  get exists(): boolean {
    return fs.existsSync(this.dir);
  }

  meta(): SlotMeta {
    return readMeta(this.dir);
  }

  setMeta(change: SlotMeta): void {
    writeMeta(this.dir, change);
  }

  /** The task the lane holds, or held last. */
  task(): string | undefined {
    return this.locked !== null ? parseReason(this.locked).task : this.meta().task;
  }

  /** The lease of the current hold, from the lock reason. */
  lease(): string | null {
    return this.locked !== null ? parseReason(this.locked).lease : null;
  }

  /** Time since anything changed the index: a session working without a lock does. */
  idleMs(): number {
    try {
      return Date.now() - fs.statSync(path.join(this.gitDir(), 'index')).mtimeMs;
    } catch {
      return Number.POSITIVE_INFINITY;
    }
  }

  /** Given back with `lane done` and not touched since. */
  released(): boolean {
    const m = this.meta();
    return Boolean(m.released) && (m.releasedAt ?? 0) >= Date.now() - this.idleMs() - 1000;
  }

  /** Commits that are on no remote branch at all. */
  ahead(): number {
    return Number(this.tryGit('rev-list', '--count', 'HEAD', '--not', '--remotes=origin') ?? '0');
  }

  pr(): Pr | null {
    return prFor(this.clone.slug(), this.branch);
  }

  /** Merged: the PR was merged from this very commit, or the base has the work (offline check). */
  merged(pr: Pr | null): boolean {
    if (pr?.state === 'MERGED' && pr.head === this.wt.head) return true;
    return mergedInto(this, `origin/${this.clone.base()}`, this.meta().start);
  }

  /** Whether giving the lane back loses nothing (see workSafe). */
  safe(pr: Pr | null): boolean {
    const unpushed = this.ahead() > 0;
    return workSafe({ dirty: this.dirty(), unpushed, mergedHere: unpushed && this.merged(pr) });
  }

  /** A hold that looks left behind: old, the slot unchanged as long, no process using it. */
  abandoned(): boolean {
    return holdAbandoned(this.dir, this.locked, this.idleMs());
  }

  /** What works in the lane now: its claims that still count (emulator, build), processes in it. */
  inUse(): string[] {
    const claims = locks().list().filter((c) => !c.stale && c.lanePath !== undefined && samePath(c.lanePath, this.dir));
    return [...claims.map((c) => c.name), ...processesUsing(this.dir).map((pid) => `pid ${pid}`)];
  }

  /** Held for a task (and since when), free, or not locked: what `lane list` shows and prints as JSON. */
  state(): LaneState {
    const idle = this.idleMs();
    const idleMs = Number.isFinite(idle) ? Math.round(idle) : null;
    if (this.locked !== null) {
      const r = parseReason(this.locked);
      return { state: 'held', task: r.task, lease: r.lease, since: r.since, abandoned: this.abandoned(), idleMs };
    }
    const rest = { lease: null, since: null, abandoned: false, idleMs };
    if (!this.exists) return { state: 'missing', task: null, ...rest };
    return { state: this.released() ? 'free' : 'unlocked', task: this.meta().task ?? null, ...rest };
  }

  stateText(): string {
    return stateText(this.state());
  }

  /** Detached (the branch is free elsewhere, deleted when safe), unlocked, folder and caches kept. */
  giveBack(safe: boolean): string {
    const task = this.task();
    const branch = this.branch;
    if (branch) this.git('switch', '--detach', '--quiet');
    if (branch && safe) this.clone.tryGit('branch', '-D', branch);
    if (this.locked !== null) this.clone.tryGit('worktree', 'unlock', this.dir);
    this.setMeta({ task, released: true, releasedAt: Date.now() });
    const kept = branch ? `; local branch ${branch} ${safe ? 'deleted (its work is on the remote or merged)' : 'kept'}` : '';
    return `gave back ${this.name}${task ? ` (was: ${task})` : ''}${kept}`;
  }

  /** Deletes the worktree, its folder and its local branch. */
  remove(): string {
    if (samePath(this.dir, this.clone.dir)) throw new Error('refusing to remove a main clone');
    if (!underRoot(this.dir)) throw new Error(`${this.dir} is not under the lane root`);
    if (this.locked !== null) this.clone.tryGit('worktree', 'unlock', this.dir);
    this.clone.tryGit('worktree', 'remove', '--force', this.dir);
    const gone = !this.exists || rmLaneFolder(this.dir);
    this.clone.tryGit('worktree', 'prune');
    if (this.branch) this.clone.tryGit('branch', '-D', this.branch);
    const what = `${this.name}${this.branch ? ` and local branch ${this.branch}` : ''}`;
    return gone ? `removed ${what}` : `removed ${what}; the folder itself is left (see warning)`;
  }
}
