// A lane: a worktree of a main clone under the lane root, usually a numbered pool slot.
import fs from 'node:fs';
import path from 'node:path';
import { Checkout, MainClone } from './checkout.ts';
import { rmLaneFolder, samePath, isInside, underRoot } from './fsutil.ts';
import { prFor, type Pr } from './github.ts';
import { age, parseReason, slotNumber, workSafe, type Worktree } from './worktrees.ts';

/** What lane keeps about a slot, in `lane.json` inside the worktree's own git folder. */
interface SlotMeta {
  task?: string;
  released?: boolean;
  releasedAt?: number;
  installStamp?: string;
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

  /** The lane named, or the one the command runs in. */
  static find(name?: string): Lane {
    const cwd = process.cwd();
    const lane = Lane.all().find((l) =>
      name ? l.name.toLowerCase() === name.toLowerCase() : samePath(l.dir, cwd) || isInside(cwd, l.dir));
    if (!lane) throw new Error(name ? `no lane called ${name} (see: lane list --local)` : 'not inside a lane; name one');
    return lane;
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
    try {
      return JSON.parse(fs.readFileSync(path.join(this.gitDir(), 'lane.json'), 'utf8')) as SlotMeta;
    } catch {
      return {};
    }
  }

  setMeta(change: SlotMeta): void {
    fs.writeFileSync(path.join(this.gitDir(), 'lane.json'), `${JSON.stringify({ ...this.meta(), ...change }, null, 2)}\n`);
  }

  /** The task the lane holds, or held last. */
  task(): string | undefined {
    return this.locked !== null ? parseReason(this.locked).task : this.meta().task;
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

  /** Whether giving the lane back loses nothing (see workSafe). */
  safe(pr: Pr | null): boolean {
    return workSafe({ dirty: this.dirty(), unpushed: this.ahead() > 0, mergedHere: pr?.state === 'MERGED' && pr.head === this.wt.head });
  }

  /** Held for a task (and how long), or free. */
  stateText(): string {
    if (this.locked !== null) {
      const r = parseReason(this.locked);
      return `held: ${r.task}${r.since ? `, ${age(Date.now() - r.since)}` : ''}`;
    }
    if (!this.exists) return 'folder missing';
    if (this.released()) return `free (last: ${this.meta().task ?? '?'})`;
    return `not locked, changed ${age(this.idleMs())} ago`;
  }

  /**
   * Gives the slot back: detached (its branch is free for another checkout, and deleted when
   * its work is on the remote), unlocked, folder and caches kept for the next task.
   */
  giveBack(safe: boolean): string {
    const task = this.task();
    const branch = this.branch;
    if (branch) this.git('switch', '--detach', '--quiet');
    if (branch && safe) this.clone.tryGit('branch', '-D', branch);
    if (this.locked !== null) this.clone.tryGit('worktree', 'unlock', this.dir);
    this.setMeta({ task, released: true, releasedAt: Date.now() });
    const kept = branch ? (safe ? `; local branch ${branch} deleted (no commit on it is missing from the remote)` : `; local branch ${branch} kept`) : '';
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
