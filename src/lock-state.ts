// What a lock on a shared thing is, and when it no longer counts.
import { errCode } from './proc.ts';

/** Who holds a lock: a lane, plus a pid when the lock lives only as long as a process. */
export interface Holder {
  lane: string;
  lanePath?: string;
  pid?: number;
  /** The lane's hold when the lock was taken: the lock ends with that hold. */
  lease?: string;
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

export interface StaleRules {
  now?: number;
  maxAgeMs: number;
  laneExists: (p: string) => boolean;
  /** The lease a lane is held under now (none once given back). */
  currentLease?: (lanePath: string) => string | undefined;
  alive?: (pid: number) => boolean;
}

/**
 * Whether an existing lock no longer counts. A `with` lock dies with its process. A `claim`
 * lock (held across many commands) dies with its lane's hold (the slot given back or taken
 * for another task: an agent killed mid-task frees the emulator then), when its lane is gone,
 * or when it is too old.
 */
export function isStale(lock: Lock, rules: StaleRules): boolean {
  const { now = Date.now(), maxAgeMs, laneExists, currentLease, alive = pidAlive } = rules;
  if (lock.pid) return !alive(lock.pid);
  if (lock.lanePath && !laneExists(lock.lanePath)) return true;
  if (lock.lease && lock.lanePath && currentLease && currentLease(lock.lanePath) !== lock.lease) return true;
  return now - lock.since > maxAgeMs;
}
