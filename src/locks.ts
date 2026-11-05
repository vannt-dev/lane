// Shared things only one lane may use at a time (the Android emulator), and a cap on heavy
// builds running at once (RAM). Locks are files under <lane root>/.locks.
import fs from 'node:fs';
import path from 'node:path';
import { isStale, type Holder, type Lock, type LockInfo, type StaleRules } from './lock-state.ts';
import { errCode, runArgv, sleepMs } from './proc.ts';

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
  private waitFor<T>(attempt: () => T | null, waiting: () => string, pollMs: number, say: Say): T {
    let told = 0;
    for (;;) {
      const got = attempt();
      if (got !== null) return got;
      if (Date.now() - told > 60_000) {
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

  /** Runs a command while holding one of `slots` numbered locks (`build-1`, `build-2`, ...). */
  withSlot(name: string, slots: number, holder: Holder, argv: readonly string[], opts: { say?: Say; cwd?: string } = {}): number {
    const names = slots > 1 ? Array.from({ length: slots }, (_, i) => `${name}-${i + 1}`) : [name];
    const got = this.waitFor(() => names.find((n) => !this.tryTake(n, { ...holder, pid: process.pid })) ?? null,
      () => `waiting for a free ${name} slot (${slots} in use)...`, 5000, opts.say ?? console.log);
    try {
      return runArgv(argv, opts.cwd);
    } finally {
      fs.rmSync(this.file(got), { force: true });
    }
  }
}
