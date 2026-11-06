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

  /** Held for a task (and how long), or free. */
  stateText(): string {
    if (this.locked !== null) {
      const r = parseReason(this.locked);
      const left = this.abandoned() ? `, looks abandoned (unchanged ${age(this.idleMs())}, no process)` : '';
      return `held: ${r.task}${r.since ? `, ${age(Date.now() - r.since)}` : ''}${left}`;
    }
    if (!this.exists) return 'folder missing';
    if (this.released()) return `free (last: ${this.meta().task ?? '?'})`;
    return `not locked, changed ${age(this.idleMs())} ago`;
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
