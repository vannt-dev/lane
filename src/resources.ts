// Commands for shared things: claim and release the emulator, cap heavy builds, list locks.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { calmrun, canHold, EXIT_WAIT_TIMEOUT, holdLease, versionText } from './calmrun.ts';
import { locks } from './checks.ts';
import { config } from './config.ts';
import { Queue } from './queue.ts';
import { readStats, summarize } from './stats.ts';
import type { Holder } from './lock-state.ts';
import { currentLease } from './meta.ts';
import type { WithOptions } from './locks.ts';
import { tryRun } from './proc.ts';
import { log, printTable } from './text.ts';
import { availableMemory, buildSlots, gb, minFreeMemory, vitestWorkers } from './heavy.ts';

/** The lane (or clone) the command runs in: its folder name and top-level path. */
function here(): Holder & { lanePath: string } {
  const top = tryRun('git', ['rev-parse', '--show-toplevel'], process.cwd());
  if (!top) throw new Error('run this inside a lane (or any git checkout)');
  return { lane: path.basename(top), lanePath: path.resolve(top), lease: currentLease(top) };
}

export function cmdClaim(resource: string, opts: { noWait: boolean }): void {
  const me = here();
  locks().take(resource, me, { wait: !opts.noWait });
  const also = holdInCalmrun(resource, me, opts.noWait);
  log(`${resource} is yours (${me.lane})${also}. Free it with: lane release ${resource}`);
}

/**
 * With calmrun installed, a claim also takes a calmrun lease on the resource (as long as a
 * claim lasts), so calmrun jobs that need it (an Android device test needs the emulator) wait
 * too. A calmrun without `hold` gets a note instead. Returns what to add to the message.
 */
function holdInCalmrun(resource: string, me: Holder, noWait: boolean): string {
  const c = calmrun();
  if (!c) return '';
  if (!canHold(c)) {
    log(`lane: calmrun ${versionText(c)} has no hold (0.3.0 or newer has): calmrun jobs will not wait for this claim`);
    return '';
  }
  const { lease, code } = holdLease(c, resource, `${me.lane}:claim`, noWait ? 1 : undefined);
  if (lease) {
    locks().setCalmrunLease(resource, lease);
    return `, in calmrun too (lease ${lease})`;
  }
  if (code === EXIT_WAIT_TIMEOUT) {
    locks().release(resource, me.lane);
    throw new Error(`${resource} is in use by a calmrun job (see calmrun status)`);
  }
  log(`lane: calmrun hold ${resource} failed (exit ${code}): calmrun jobs will not wait for this claim`);
  return '';
}

/** A line saying calmrun runs `lane with` commands, or '' when lane's own line does. */
function calmrunNote(): string {
  const c = calmrun();
  return c ? `calmrun ${versionText(c)} runs lane with commands (LANE_CALMRUN=0: lane's own line): ` : '';
}

export function cmdRelease(resource: string): void {
  log(locks().release(resource, here().lane) ? `released ${resource}` : `${resource} was not held`);
}

export function cmdLocks(opts: { json?: boolean } = {}): void {
  const all = locks().list();
  const waiting = waiters();
  if (opts.json) {
    console.log(JSON.stringify({
      locks: all,
      waiting: waiting.map(({ id: _id, ...w }) => w),
      memory: { availableBytes: availableMemory(), minFreeBytes: minFreeMemory(), totalBytes: os.totalmem() },
      calmrun: calmrun() ? versionText(calmrun()!) : null,
    }, null, 2));
    return;
  }
  const note = calmrunNote();
  if (note) log(`${note}its jobs are in calmrun status\n`);
  if (all.length === 0 && waiting.length === 0) return log('no locks held');
  if (all.length > 0) printTable(['resource', 'held by', 'since', 'state'], all.map((l) => [
    l.name,
    l.lane ?? '?',
    l.since ? new Date(l.since).toLocaleTimeString() : '?',
    l.stale ? 'stale (will be taken over)' : l.pid ? `running (pid ${l.pid})` : 'claimed',
  ]));
  if (waiting.length > 0) {
    log('');
    printTable(['waiting for', 'place', 'lane', 'command', 'since', 'needs'], waiting.map((w) => [
      w.res, String(w.place), w.lane, w.label ?? '?', new Date(w.since).toLocaleTimeString(),
      `${w.cost}${w.prio === 'high' ? ' (high)' : ''}`,
    ]));
    const stuck = waiting.filter((w) => Date.now() - w.since > 30 * 60_000);
    if (stuck.length > 0) log(`\n${stuck.length} command(s) waited over 30 minutes: is a slot held by something that hangs?`);
  }
}

/**
 * Moves the waiting commands whose label (or lane) holds `text` to the front of their line:
 * high priority, as if they had come first. Returns how many moved.
 */
export function cmdBump(text: string): number {
  const dir = path.join(locks().dir, 'queue');
  let moved = 0;
  if (fs.existsSync(dir)) {
    for (const res of fs.readdirSync(dir)) {
      const queue = new Queue(path.join(dir, res));
      for (const { id, ...w } of queue.line()) {
        if (!(w.label ?? '').includes(text) && !w.lane.includes(text)) continue;
        queue.update(id, { ...w, prio: 'high' });
        log(`moved ${w.label ?? w.lane} (${w.lane}) to the front of ${res}`);
        moved++;
      }
    }
  }
  if (moved === 0) log(`no waiting command matches "${text}"`);
  const note = calmrunNote();
  if (note) log(`${note}calmrun bump "${text}" moves those`);
  return moved;
}

/** What suits this machine: slots of build, test workers and free memory, and how to set them. */
export function cmdTune(): void {
  const cores = os.availableParallelism();
  const total = os.totalmem();
  const slots = buildSlots(cores, total);
  const workers = vitestWorkers(cores);
  const minFree = Math.max(3, Math.round(total / 1024 ** 3 / 8));
  const note = calmrunNote();
  if (note) {
    log(`${note}calmrun's budget, memory and worker settings apply (calmrun doctor suggests them). ` +
      'The settings below count only with LANE_CALMRUN=0, or for resources other than build (their slots).\n');
  }
  log(`${cores} logical cores, ${gb(total)} RAM, ${gb(availableMemory())} free now`);
  printTable(['setting', 'suggested', 'now'], [
    ['LANE_WITH_SLOTS', `build=${slots}`, process.env.LANE_WITH_SLOTS ?? `(not set: build=${slots})`],
    ['LANE_VITEST_WORKERS', String(workers), process.env.LANE_VITEST_WORKERS ?? `(not set: ${workers})`],
    ['LANE_WITH_MIN_FREE_GB', String(minFree), process.env.LANE_WITH_MIN_FREE_GB ?? `(not set: ${minFree})`],
  ]);
  const set = process.platform === 'win32' ? (k: string, v: string) => `setx ${k} "${v}"` : (k: string, v: string) => `export ${k}="${v}"`;
  log(`\nTo fix them (then open a new terminal):\n  ${set('LANE_WITH_SLOTS', `build=${slots}`)}\n  ` +
    `${set('LANE_VITEST_WORKERS', String(workers))}\n  ${set('LANE_WITH_MIN_FREE_GB', String(minFree))}`);
  log('\nA laptop that runs hot, or a hard disk instead of an SSD: take 1 or 2 slots off. ' +
    'CPU at 100% and the machine stutters: one slot less; CPU under 60% while commands wait: one more. ' +
    'Tests time out: fewer workers. `lane stats` shows the waits.');
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
  const note = calmrunNote();
  if (note) log(`${note}see calmrun stats. Below: runs lane's own line made.\n`);
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
