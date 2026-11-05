// What a lock on a shared thing is, and when it no longer counts.
import { errCode } from './proc.ts';

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

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return errCode(e) === 'EPERM';
  }
}

/**
 * Whether an existing lock no longer counts. A `with` lock dies with its process; a `claim`
 * lock (held across many commands) dies when its lane is gone or it is too old.
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
