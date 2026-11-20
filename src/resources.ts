// Commands for shared things: claim and release the emulator, cap heavy builds, list locks.
import fs from 'node:fs';
import path from 'node:path';
import { locks } from './checks.ts';
import { config } from './config.ts';
import { Queue } from './queue.ts';
import { readStats, summarize } from './stats.ts';
import type { Holder } from './lock-state.ts';
import { currentLease } from './meta.ts';
import type { WithOptions } from './locks.ts';
import { tryRun } from './proc.ts';
import { log, printTable } from './text.ts';

/** The lane (or clone) the command runs in: its folder name and top-level path. */
function here(): Holder & { lanePath: string } {
  const top = tryRun('git', ['rev-parse', '--show-toplevel'], process.cwd());
  if (!top) throw new Error('run this inside a lane (or any git checkout)');
  return { lane: path.basename(top), lanePath: path.resolve(top), lease: currentLease(top) };
}

export function cmdClaim(resource: string, opts: { noWait: boolean }): void {
  const me = here();
  locks().take(resource, me, { wait: !opts.noWait });
  log(`${resource} is yours (${me.lane}). Free it with: lane release ${resource}`);
}

export function cmdRelease(resource: string): void {
  log(locks().release(resource, here().lane) ? `released ${resource}` : `${resource} was not held`);
}

export function cmdLocks(): void {
  const all = locks().list();
  const waiting = waiters();
  if (all.length === 0 && waiting.length === 0) return log('no locks held');
  if (all.length > 0) printTable(['resource', 'held by', 'since', 'state'], all.map((l) => [
    l.name,
    l.lane ?? '?',
    l.since ? new Date(l.since).toLocaleTimeString() : '?',
    l.stale ? 'stale (will be taken over)' : l.pid ? `running (pid ${l.pid})` : 'claimed',
  ]));
  if (waiting.length > 0) {
    log('');
    printTable(['waiting for', 'place', 'lane', 'since', 'needs'], waiting.map((w) => [
      w.res, String(w.place), w.lane, new Date(w.since).toLocaleTimeString(), `${w.cost}${w.prio === 'high' ? ' (high)' : ''}`,
    ]));
  }
}

/** Every command waiting in line for a `lane with` resource. */
function waiters() {
  const dir = path.join(locks().dir, 'queue');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).flatMap((res) =>
    new Queue(path.join(dir, res)).line().map((w, i) => ({ ...w, res, place: i + 1 })));
}

/** Waiting and running times of `lane with` commands over the last days, most waiting first. */
export function cmdStats(days: number): void {
  const rows = summarize(readStats(config.root), { days });
  if (rows.length === 0) return log(`no lane with runs in the last ${days} day(s)`);
  const s = (ms: number) => `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  printTable(['resource', 'command', 'runs', 'failed', 'wait avg', 'wait max', 'run avg'], rows.map((r) => [
    r.res, r.label, String(r.runs), String(r.failed), s(r.avgWaitMs), s(r.maxWaitMs), s(r.avgRunMs),
  ]));
}

export function cmdWith(resource: string, argv: readonly string[], slots: number, opts: WithOptions = {}): number {
  return locks().withSlot(resource, slots, here(), argv, opts);
}
