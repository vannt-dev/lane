// Commands for shared things: claim and release the emulator, cap heavy builds, list locks.
import path from 'node:path';
import { locks } from './checks.ts';
import type { Holder } from './lock-state.ts';
import { tryRun } from './proc.ts';
import { log, printTable } from './text.ts';

/** The lane (or clone) the command runs in: its folder name and top-level path. */
function here(): Holder & { lanePath: string } {
  const top = tryRun('git', ['rev-parse', '--show-toplevel'], process.cwd());
  if (!top) throw new Error('run this inside a lane (or any git checkout)');
  return { lane: path.basename(top), lanePath: path.resolve(top) };
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
  if (all.length === 0) return log('no locks held');
  printTable(['resource', 'held by', 'since', 'state'], all.map((l) => [
    l.name,
    l.lane ?? '?',
    l.since ? new Date(l.since).toLocaleTimeString() : '?',
    l.stale ? 'stale (will be taken over)' : l.pid ? `running (pid ${l.pid})` : 'claimed',
  ]));
}

export function cmdWith(resource: string, slots: number, argv: readonly string[]): number {
  return locks().withSlot(resource, slots, here(), argv);
}
