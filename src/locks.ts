// Shared things only one lane may use at a time (the Android emulator), and a cap on
// heavy builds running at once (RAM). Locks are files under <lane root>/.locks.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { errCode, sleepMs } from './sh.ts';

/** Who holds a lock: a lane, plus a pid when the lock lives only as long as a process. */
export interface Holder {
  lane: string;
  lanePath?: string;
  pid?: number;
}

export interface Lock extends Holder {
  since: number;
}

export interface LockInfo extends Partial<Lock> {
  name: string;
  stale: boolean;
}

type Say = (msg: string) => void;

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return errCode(e) === 'EPERM';
  }
}

/**
 * Whether an existing lock no longer counts. A `with` lock dies with its process;
 * a `claim` lock (held across many commands) dies when its lane is gone or it is too old.
 */
export function isStale(
  lock: Lock,
  opts: { now?: number; maxAgeMs: number; laneExists: (p: string) => boolean; alive?: (pid: number) => boolean },
): boolean {
  const { now = Date.now(), maxAgeMs, laneExists, alive = pidAlive } = opts;
  if (lock.pid) return !alive(lock.pid);
  if (lock.lanePath && !laneExists(lock.lanePath)) return true;
  return now - lock.since > maxAgeMs;
}

export class Locks {
  readonly dir: string;
  readonly maxAgeMs: number;

  constructor(root: string, { maxAgeMs = 3 * 3600_000 }: { maxAgeMs?: number } = {}) {
    this.dir = path.join(root, '.locks');
    this.maxAgeMs = maxAgeMs;
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
    return isStale(lock, { maxAgeMs: this.maxAgeMs, laneExists: fs.existsSync });
  }

  /** Take the lock if free (or stale). Returns null on success, else the current holder. */
  tryTake(name: string, holder: Holder): Lock | null {
    fs.mkdirSync(this.dir, { recursive: true });
    const f = this.file(name);
    // Windows refuses a file another process is touching right now: that means busy, not error.
    const busy: Lock = { lane: '?', since: Date.now() };
    for (let i = 0; i < 2; i++) {
      try {
        fs.writeFileSync(f, JSON.stringify({ ...holder, since: Date.now() }), { flag: 'wx' });
        return null;
      } catch (e) {
        const code = errCode(e);
        if (code === 'EPERM' || code === 'EBUSY' || code === 'EACCES') return busy;
        if (code !== 'EEXIST') throw e;
        const cur = this.read(name);
        if (cur) {
          if (!this.stale(cur)) return cur;
        } else {
          // Unreadable: most likely being written this instant. Only clear it once it is old.
          let age: number;
          try {
            age = Date.now() - fs.statSync(f).mtimeMs;
          } catch {
            continue;
          }
          if (age < 10_000) return busy;
        }
        try {
          fs.rmSync(f, { force: true });
        } catch {
          return busy;
        }
      }
    }
    return this.read(name) ?? busy;
  }

  /** Wait for the lock, printing who holds it now and then. */
  take(name: string, holder: Holder, { wait = true, pollMs = 5000, say = console.log as Say } = {}): void {
    let told = 0;
    for (;;) {
      const cur = this.tryTake(name, holder);
      if (!cur) return;
      if (!wait) throw new Error(`${name} is held by ${cur.lane} since ${new Date(cur.since).toLocaleTimeString()}`);
      if (Date.now() - told > 60_000) {
        say(`waiting for ${name} (held by ${cur.lane})...`);
        told = Date.now();
      }
      sleepMs(pollMs);
    }
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
      const name = f.slice(0, -5);
      const lock = this.read(name);
      return { name, ...lock, stale: lock ? this.stale(lock) : true };
    });
  }

  /** Run a command while holding one of `slots` numbered locks (`build-1`, `build-2`, ...). */
  withSlot(
    name: string,
    slots: number,
    holder: Holder,
    argv: readonly string[],
    { say = console.log as Say, cwd }: { say?: Say; cwd?: string } = {},
  ): number {
    const names = slots > 1 ? Array.from({ length: slots }, (_, i) => `${name}-${i + 1}`) : [name];
    let got: string | undefined;
    let told = 0;
    for (;;) {
      got = names.find((n) => !this.tryTake(n, { ...holder, pid: process.pid }));
      if (got) break;
      if (Date.now() - told > 60_000) {
        say(`waiting for a free ${name} slot (${slots} in use)...`);
        told = Date.now();
      }
      sleepMs(5000);
    }
    try {
      return runArgv(argv, cwd);
    } finally {
      fs.rmSync(this.file(got), { force: true });
    }
  }
}

/**
 * Run a command given as argv. One element = a command line for the shell, as typed.
 * Several = run directly, so characters like > or & stay literal; Windows .cmd/.bat
 * tools (npm, flutter) cannot run without a shell, so they get one with each argument quoted.
 */
export function runArgv(argv: readonly string[], cwd?: string): number {
  const [cmd, ...args] = argv;
  if (cmd === undefined) throw new Error('no command given');
  const opts = { stdio: 'inherit', windowsHide: true, cwd } as const;
  if (args.length === 0) return spawnSync(cmd, { ...opts, shell: true }).status ?? 1;
  let r = spawnSync(cmd, args, opts);
  const code = errCode(r.error);
  if (r.error && process.platform === 'win32' && (code === 'ENOENT' || code === 'EINVAL')) {
    const q = (a: string) => (/^[\w./:=@+-]+$/.test(a) ? a : `"${a.replace(/"/g, '""')}"`);
    r = spawnSync(argv.map(q).join(' '), { ...opts, shell: true });
  }
  return r.error ? 1 : (r.status ?? 1);
}
