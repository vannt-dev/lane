// Shared things only one lane may use at a time (the Android emulator), and a cap on
// heavy builds running at once (RAM). Locks are files under <lane root>/.locks.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

export function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

/**
 * Whether an existing lock no longer counts. A `with` lock dies with its process;
 * a `claim` lock (held across many commands) dies when its lane is gone or it is too old.
 */
export function isStale(lock, { now = Date.now(), maxAgeMs, laneExists, alive = pidAlive }) {
  if (lock.pid) return !alive(lock.pid);
  if (lock.lanePath && !laneExists(lock.lanePath)) return true;
  return now - lock.since > maxAgeMs;
}

export class Locks {
  constructor(root, { maxAgeMs = 3 * 3600_000 } = {}) {
    this.dir = path.join(root, '.locks');
    this.maxAgeMs = maxAgeMs;
  }

  file(name) {
    if (!/^[a-z0-9._-]+$/i.test(name)) throw new Error(`bad resource name: ${name}`);
    return path.join(this.dir, `${name}.json`);
  }

  read(name) {
    try {
      return JSON.parse(fs.readFileSync(this.file(name), 'utf8'));
    } catch {
      return null;
    }
  }

  /** Take the lock if free (or stale). Returns null on success, else the current holder. */
  tryTake(name, holder) {
    fs.mkdirSync(this.dir, { recursive: true });
    const f = this.file(name);
    // Windows refuses a file another process is touching right now: that means busy, not error.
    const busy = { lane: '?', since: Date.now() };
    for (let i = 0; i < 2; i++) {
      try {
        fs.writeFileSync(f, JSON.stringify({ ...holder, since: Date.now() }), { flag: 'wx' });
        return null;
      } catch (e) {
        if (['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) return busy;
        if (e.code !== 'EEXIST') throw e;
        const cur = this.read(name);
        if (cur) {
          if (!isStale(cur, { maxAgeMs: this.maxAgeMs, laneExists: fs.existsSync })) return cur;
        } else {
          // Unreadable: most likely being written this instant. Only clear it once it is old.
          let age;
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
  take(name, holder, { wait = true, pollMs = 5000, say = console.log } = {}) {
    let told = 0;
    for (;;) {
      const cur = this.tryTake(name, holder);
      if (!cur) return;
      if (!wait) throw new Error(`${name} is held by ${cur.lane} since ${new Date(cur.since).toLocaleTimeString()}`);
      if (Date.now() - told > 60_000) {
        say(`waiting for ${name} (held by ${cur.lane})...`);
        told = Date.now();
      }
      sleep(pollMs);
    }
  }

  release(name, lane) {
    const cur = this.read(name);
    if (!cur) return false;
    if (lane && cur.lane !== lane) throw new Error(`${name} is held by ${cur.lane}, not ${lane}`);
    fs.rmSync(this.file(name), { force: true });
    return true;
  }

  list() {
    if (!fs.existsSync(this.dir)) return [];
    return fs.readdirSync(this.dir).filter((f) => f.endsWith('.json')).map((f) => {
      const name = f.slice(0, -5);
      const lock = this.read(name);
      const stale = lock ? isStale(lock, { maxAgeMs: this.maxAgeMs, laneExists: fs.existsSync }) : true;
      return { name, ...lock, stale };
    });
  }

  /** Run a command while holding one of `slots` numbered locks (`build-1`, `build-2`, ...). */
  withSlot(name, slots, holder, argv, { say = console.log } = {}) {
    const names = slots > 1 ? Array.from({ length: slots }, (_, i) => `${name}-${i + 1}`) : [name];
    let got = null;
    let told = 0;
    while (!got) {
      got = names.find((n) => !this.tryTake(n, { ...holder, pid: process.pid }));
      if (got) break;
      if (Date.now() - told > 60_000) {
        say(`waiting for a free ${name} slot (${slots} in use)...`);
        told = Date.now();
      }
      sleep(5000);
    }
    try {
      return runArgv(argv);
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
export function runArgv(argv) {
  const opts = { stdio: 'inherit', windowsHide: true };
  if (argv.length === 1) return spawnSync(argv[0], { ...opts, shell: true }).status ?? 1;
  let r = spawnSync(argv[0], argv.slice(1), opts);
  if (r.error && process.platform === 'win32' && ['ENOENT', 'EINVAL'].includes(r.error.code)) {
    const q = (a) => (/^[\w./:=@+-]+$/.test(a) ? a : `"${a.replace(/"/g, '""')}"`);
    r = spawnSync(argv.map(q).join(' '), { ...opts, shell: true });
  }
  return r.error ? 1 : (r.status ?? 1);
}
