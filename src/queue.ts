// The line of commands waiting for a `lane with` resource: one file per waiter under
// <lane root>/.locks/queue/<resource>. The head of the line takes slots first; a later waiter
// may pass it only while it fits at once and nobody ahead has waited past the pass limit, so a
// command that needs two slots is never passed over for long by commands that need one.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pidAlive } from './lock-state.ts';

export interface Waiter {
  lane: string;
  pid: number;
  cost: number;
  /** `high` waits ahead of every `normal` waiter, never ahead of a command already running. */
  prio: 'high' | 'normal';
  since: number;
  /** A short name of the command (never its arguments), for `lane locks` and `lane bump`. */
  label?: string;
}

export class Queue {
  readonly dir: string;
  private readonly alive: (pid: number) => boolean;

  constructor(dir: string, alive: (pid: number) => boolean = pidAlive) {
    this.dir = dir;
    this.alive = alive;
  }

  /** Joins the line; returns this waiter's id. Written whole (rename), so a reader never sees half a file. */
  join(w: Waiter): string {
    fs.mkdirSync(this.dir, { recursive: true });
    const id = `${w.since}-${w.pid}-${crypto.randomBytes(3).toString('hex')}`;
    const tmp = path.join(this.dir, `${id}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(w));
    fs.renameSync(tmp, path.join(this.dir, `${id}.json`));
    return id;
  }

  /** Rewrites a waiter (e.g. `lane bump` raising its priority), whole like join. */
  update(id: string, w: Waiter): void {
    const tmp = path.join(this.dir, `${id}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(w));
    fs.renameSync(tmp, path.join(this.dir, `${id}.json`));
  }

  leave(id: string): void {
    fs.rmSync(path.join(this.dir, `${id}.json`), { force: true });
  }

  /** The waiters in order: high first, then first come. A waiter whose process ended is removed. */
  line(): (Waiter & { id: string })[] {
    let files: string[];
    try {
      files = fs.readdirSync(this.dir).filter((f) => f.endsWith('.json'));
    } catch {
      return [];
    }
    const all: (Waiter & { id: string })[] = [];
    for (const f of files) {
      const id = f.slice(0, -5);
      let w: Waiter;
      try {
        w = JSON.parse(fs.readFileSync(path.join(this.dir, f), 'utf8')) as Waiter;
      } catch {
        continue; // removed while reading
      }
      if (this.alive(w.pid)) all.push({ ...w, id });
      else this.leave(id);
    }
    const rank = (w: Waiter) => (w.prio === 'high' ? 0 : 1);
    return all.sort((a, b) => rank(a) - rank(b) || a.since - b.since || a.id.localeCompare(b.id));
  }
}
