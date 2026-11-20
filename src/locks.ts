// Shared things only one lane may use at a time (the Android emulator), and a cap on heavy
// builds running at once (RAM). Locks are files under <lane root>/.locks.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isStale, pidAlive, type Holder, type Lock, type LockInfo, type StaleRules } from './lock-state.ts';
import { errCode, runArgv, sleepMs } from './proc.ts';
import { Queue } from './queue.ts';
import { commandLabel, logRun } from './stats.ts';

type Say = (msg: string) => void;

const BUSY_CODES = ['EPERM', 'EBUSY', 'EACCES'];

export class Locks {
  readonly dir: string;
  private readonly rules: StaleRules;

  constructor(root: string, rules: Partial<StaleRules> = {}) {
    this.dir = path.join(root, '.locks');
    this.rules = { maxAgeMs: 3 * 3600_000, laneExists: fs.existsSync, ...rules };
  }

  file(name: string): string {
    if (!/^[a-z0-9._-]+$/i.test(name)) throw new Error(`bad resource name: ${name}`);
    return path.join(this.dir, `${name}.json`);
  }

  read(name: string): Lock | null {
    try {
      return JSON.parse(fs.readFileSync(this.file(name), 'utf8')) as Lock;
    } catch {
      return null;
    }
  }

  private stale(lock: Lock): boolean {
    return isStale(lock, this.rules);
  }

  /** An unreadable lock file is most likely being written this instant: busy until it is old. */
  private freshUnreadable(file: string): boolean {
    try {
      return Date.now() - fs.statSync(file).mtimeMs < 10_000;
    } catch {
      return false;
    }
  }

  /** Takes the lock if free (or stale). Returns null on success, else the current holder. */
  tryTake(name: string, holder: Holder): Lock | null {
    fs.mkdirSync(this.dir, { recursive: true });
    const file = this.file(name);
    // Windows refuses a file another process is touching right now: that means busy, not error
    const busy: Lock = { lane: '?', since: Date.now() };
    for (let i = 0; i < 2; i++) {
      try {
        fs.writeFileSync(file, JSON.stringify({ ...holder, since: Date.now() }), { flag: 'wx' });
        return null;
      } catch (e) {
        if (BUSY_CODES.includes(errCode(e) ?? '')) return busy;
        if (errCode(e) !== 'EEXIST') throw e;
        const cur = this.read(name);
        if (cur ? !this.stale(cur) : this.freshUnreadable(file)) return cur ?? busy;
        try {
          fs.rmSync(file, { force: true });
        } catch {
          return busy;
        }
      }
    }
    return this.read(name) ?? busy;
  }

  /** Tries `attempt` until it gives a value, saying now and then what it waits for. */
  private waitFor<T>(attempt: () => T | null, waiting: () => string, pollMs: number, say: Say, tellMs = 60_000): T {
    let told = 0;
    for (;;) {
      const got = attempt();
      if (got !== null) return got;
      if (Date.now() - told > tellMs) {
        say(waiting());
        told = Date.now();
      }
      sleepMs(pollMs);
    }
  }

  /** Takes the lock, waiting while someone else holds it (unless `wait` is off). */
  take(name: string, holder: Holder, { wait = true, pollMs = 5000, say = console.log as Say } = {}): void {
    let cur: Lock | null = null;
    this.waitFor(() => {
      cur = this.tryTake(name, holder);
      if (cur && !wait) throw new Error(`${name} is held by ${cur.lane} since ${new Date(cur.since).toLocaleTimeString()}`);
      return cur ? null : true;
    }, () => `waiting for ${name} (held by ${cur?.lane ?? '?'})...`, pollMs, say);
  }

  release(name: string, lane?: string): boolean {
    const cur = this.read(name);
    if (!cur) return false;
    if (lane && cur.lane !== lane) throw new Error(`${name} is held by ${cur.lane}, not ${lane}`);
    fs.rmSync(this.file(name), { force: true });
    return true;
  }

  list(): LockInfo[] {
    if (!fs.existsSync(this.dir)) return [];
    return fs.readdirSync(this.dir).filter((f) => f.endsWith('.json')).map((f) => {
      const lock = this.read(f.slice(0, -5));
      return { name: f.slice(0, -5), ...lock, stale: lock ? this.stale(lock) : true };
    });
  }

  /**
   * Takes `cost` of the `slots` numbered locks (`build-1`, `build-2`, ...; just `build` when
   * there is one slot), all or none: a part taken is given back. Returns the names, or null.
   */
  takeSlots(name: string, slots: number, cost: number, holder: Holder): string[] | null {
    const names = slots > 1 ? Array.from({ length: slots }, (_, i) => `${name}-${i + 1}`) : [name];
    const got: string[] = [];
    for (const n of names) {
      if (got.length === cost) break;
      if (!this.tryTake(n, holder)) got.push(n);
    }
    if (got.length === cost) return got;
    for (const n of got) fs.rmSync(this.file(n), { force: true });
    return null;
  }

  /** How many of the slots are held now. */
  private inUse(name: string, slots: number): number {
    const names = slots > 1 ? Array.from({ length: slots }, (_, i) => `${name}-${i + 1}`) : [name];
    return names.filter((n) => {
      const cur = this.read(n);
      return cur !== null && !this.stale(cur);
    }).length;
  }

  /**
   * Runs a command while holding `cost` of `slots` numbered locks, waiting in line for them
   * (see Queue), at below-normal CPU priority (LANE_LOW_CPU=0: normal). A command run by
   * another `lane with` of the same resource (LANE_WITH names it) runs at once: its caller
   * holds the slots already. Each run is logged for `lane stats`.
   */
  withSlot(name: string, slots: number, holder: Holder, argv: readonly string[], opts: WithOptions = {}): number {
    const { cost = 1, prio = 'normal', pollMs = 2000, tellMs = 30_000, say = console.log } = opts;
    if (cost > slots) throw new Error(`--cost ${cost} is more than the ${slots} slots of ${name}: raise --slots or LANE_WITH_SLOTS`);
    if (heldByCaller(name)) return runArgv(argv, opts.cwd);
    const me = { ...holder, pid: process.pid };
    const queue = new Queue(path.join(this.dir, 'queue', name));
    const start = Date.now();
    const id = queue.join({ lane: holder.lane, pid: process.pid, cost, prio, since: start });
    let place = 0;
    let got: string[];
    try {
      got = this.waitFor(() => {
        place = queue.line().findIndex((w) => w.id === id);
        return place === 0 ? this.takeSlots(name, slots, cost, me) : null;
      }, () => `waiting for ${name}: ${this.inUse(name, slots)} of ${slots} slots in use, ${ordinal(place + 1)} in line` +
        `${cost > 1 ? ` (needs ${cost})` : ''}...`, pollMs, say, tellMs);
    } finally {
      queue.leave(id);
    }
    const ran = Date.now();
    let status = 1;
    try {
      const env = { ...process.env, LANE_WITH: [process.env.LANE_WITH, `${name}:${process.pid}`].filter(Boolean).join(',') };
      status = lowCpu(() => runArgv(argv, opts.cwd, env));
      return status;
    } finally {
      for (const n of got) fs.rmSync(this.file(n), { force: true });
      logRun(path.dirname(this.dir), {
        at: start, res: name, label: opts.label ?? commandLabel(argv), cost, waitMs: ran - start, runMs: Date.now() - ran, status,
      });
    }
  }
}

export interface WithOptions {
  say?: Say;
  cwd?: string;
  /** Slots the command needs (a heavy test run 2, a lint 1). */
  cost?: number;
  prio?: 'high' | 'normal';
  /** The name in `lane stats`; else the tool and its subcommand. */
  label?: string;
  pollMs?: number;
  /** How often a waiting command says its place in line. */
  tellMs?: number;
}

/** Whether a `lane with` that is still running holds this resource for the process calling us. */
function heldByCaller(name: string): boolean {
  return (process.env.LANE_WITH ?? '').split(',').some((part) => {
    const [res, pid] = part.split(':');
    return res === name && Number(pid) > 0 && pidAlive(Number(pid));
  });
}

/**
 * Runs `fn` with this process at below-normal priority: a program it starts inherits it
 * (Windows priority class, Unix nice). Put back after when the system allows it.
 */
function lowCpu<T>(fn: () => T): T {
  if (process.env.LANE_LOW_CPU === '0') return fn();
  let before: number | undefined;
  try {
    before = os.getPriority();
    if (before < os.constants.priority.PRIORITY_BELOW_NORMAL) os.setPriority(os.constants.priority.PRIORITY_BELOW_NORMAL);
    else before = undefined;
  } catch {
    before = undefined;
  }
  try {
    return fn();
  } finally {
    try {
      if (before !== undefined) os.setPriority(before);
    } catch {
      // Unix: only root raises a priority again; this process ends soon anyway
    }
  }
}

function ordinal(n: number): string {
  const s = n % 100 >= 11 && n % 100 <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th';
  return `${n}${s}`;
}
