// Working in one lane: take a slot, give it back, free a left-behind hold, its port and brief.
import { spawnSync } from 'node:child_process';
import { MainClone } from './checkout.ts';
import { checksFor } from './checks.ts';
import { config, poolName } from './config.ts';
import { findLane } from './find.ts';
import { Lane } from './lane.ts';
import { SlotPool } from './pool.ts';
import { LaneSetup } from './setup.ts';
import { chosenDirs, currentDirs, missingDirs } from './sparse.ts';
import { ABANDONED_MS } from './stale.ts';
import { targetFor, type TargetOptions } from './target.ts';
import { briefText, log } from './text.ts';
import { age } from './worktrees.ts';

interface NewOptions extends TargetOptions {
  install: boolean;
  open: boolean;
  /** Only these folders (`--sparse`); else `.lanesparse`, else the whole repository. */
  sparse?: string[];
  /** Every file, whatever `.lanesparse` says (`--no-sparse`). */
  full?: boolean;
  /** npm dependencies as hard links from a lane on the same lockfile (`--link-deps`). */
  linkDeps?: boolean;
  /** The pool to take a slot from (`--pool review`); none for the default pool. */
  pool?: string;
  /** The agent to start or name (`--agent codex`): a known name or a command line; else Claude Code. */
  agent?: string;
}

/** Takes a slot for a task (see SlotPool.take) and sets it up; returns its folder. */
export function cmdNew(repo: string, task: string | undefined, opts: NewOptions): string {
  const clone = new MainClone(repo);
  const name = task ?? (opts.pr !== undefined ? `pr-${opts.pr}` : undefined);
  if (opts.agent !== undefined && !opts.agent.trim()) throw new Error('--agent needs a name (claude, codex, gemini, opencode) or a command');
  if (!name) throw new Error('lane new needs a task name, or --pr <number>');
  const pool = new SlotPool(clone);
  // Before targetFor: the task's own branch exists already, and "branch exists" hides the cause.
  const held = pool.heldFor(name);
  if (held) throw new Error(`${name} already holds ${held}: work there, or give it back with lane done ${held}`);
  const dirs = chosenDirs(clone, opts);
  const group = poolName(opts.pool);
  clone.fetch();
  const target = targetFor(clone, name, opts);
  const { lane, reused } = pool.take(name, target, dirs, group);
  const lease = lane.lease();
  const kind = `${reused ? 'reused' : 'new'} slot${group ? ` of pool ${group}` : ''}`;
  log(`lane ${lane.name} (${kind}): ${target.describe()}, held for ${name}, lease ${lease}`);
  if (dirs.length > 0) {
    log(`sparse: ${dirs.join(', ')} (and the files at the root)`);
    const missing = missingDirs(lane, dirs);
    if (missing.length > 0) log(`note: no such folder in this commit: ${missing.join(', ')} (--sparse takes folders, not files)`);
  }
  new LaneSetup(lane).run({ install: opts.install, linkDeps: opts.linkDeps });
  const agent = agentCommand(opts.agent);
  if (!opts.open || !openAgent(lane.dir, agent))
    log(`\nnext: cd ${lane.dir} && ${agent}   (agents: lane brief ${lane.name}; when pushed: lane done --lease ${lease})`);
  return lane.dir;
}

/** Agent CLIs `--agent` knows by name, and the command that starts each. */
export const AGENTS: ReadonlyMap<string, string> = new Map([
  ['claude', 'claude'],
  ['codex', 'codex'],
  ['gemini', 'gemini'],
  ['opencode', 'opencode'],
  ['copilot', 'copilot'],
  ['cursor', 'cursor-agent'],
]);

/** The command for `--agent`: a known name's command, any other text as given, else Claude Code. */
export function agentCommand(agent?: string): string {
  const a = agent?.trim();
  if (!a) return 'claude';
  return AGENTS.get(a) ?? a;
}

/** A program that opens a new terminal tab or window running a command in a folder. */
export interface OpenPlan {
  program: string;
  args: string[];
  name: string;
  /** Windows: the arguments go to the program as written, so the command line stays as typed. */
  verbatim?: boolean;
}

/**
 * Where `--open` starts the agent: a new Windows Terminal tab on Windows, a new tmux window
 * inside tmux; elsewhere null, and lane prints the command to run instead. Windows Terminal
 * starts only .exe files, and npm installs agents as .cmd files: cmd.exe runs it (and stays
 * in the lane when the agent exits).
 */
export function openPlan(dir: string, command: string, where: { platform: NodeJS.Platform; tmux?: string }): OpenPlan | null {
  if (where.platform === 'win32') {
    const args = ['-w', '0', 'nt', '-d', `"${dir}"`, 'cmd', '/k', command];
    return { program: 'wt.exe', args, name: 'Windows Terminal', verbatim: true };
  }
  if (where.tmux) return { program: 'tmux', args: ['new-window', '-c', dir, command], name: 'tmux' };
  return null;
}

/**
 * Starts the agent in a new tab or window; false when it did not (nothing to open it with,
 * or the terminal failed), so the caller prints the command instead. Both programs hand the
 * tab over and exit at once.
 */
export function openAgent(dir: string, command: string, plan?: OpenPlan | null): boolean {
  if (plan === undefined) plan = openPlan(dir, command, { platform: process.platform, tmux: process.env.TMUX });
  if (!plan) return false;
  const opts = { stdio: 'ignore', windowsHide: true, timeout: 15_000, windowsVerbatimArguments: plan.verbatim } as const;
  const r = spawnSync(plan.program, plan.args, opts);
  if (r.error || r.status !== 0) {
    log(`could not open ${plan.name} (${r.error ? r.error.message : `exit ${r.status}`})`);
    return false;
  }
  log(`opened ${command} in ${dir} (${plan.name})`);
  return true;
}

/**
 * Gives a slot back once its work is safe (--force: unpushed commits stay on the local branch).
 * With --lease, refuses when the slot is held under another lease: a late give-back from a task
 * that already ended never frees the task that took the slot after it.
 */
export function cmdDone(name: string | undefined, opts: { force: boolean; lease?: string }): void {
  const lane = findLane(name);
  if (opts.lease && lane.lease() !== opts.lease)
    throw new Error(`${lane.name} is not held under lease ${opts.lease} any more (${lane.stateText()}); nothing given back`);
  const dirty = lane.dirty();
  if (dirty) throw new Error(`${lane.name} has ${dirty} uncommitted change(s): commit and push them first`);
  const safe = lane.safe(lane.pr());
  if (!safe && !opts.force)
    throw new Error(`${lane.name} has ${lane.ahead()} commit(s) on no remote branch: push them, or --force to keep them on the local branch`);
  log(lane.giveBack(safe));
}

/**
 * Frees a hold that looks left behind (an agent killed or closed without `lane done`): held and
 * unchanged for hours, no process using the slot. --force frees one that does not look so.
 * Never when work in it would be lost.
 */
export function cmdFree(name: string, opts: { yes: boolean; force: boolean }): void {
  const lane = findLane(name);
  if (lane.locked === null) return log(`${lane.name} is not held`);
  if (!opts.force && !lane.abandoned())
    throw new Error(`${lane.name} does not look abandoned (${lane.stateText()}): that takes ${age(ABANDONED_MS)} ` +
      'held and unchanged with no process in it; --force frees it anyway');
  if (!lane.safe(lane.pr()))
    throw new Error(`${lane.name} holds work that is not on the remote; freeing it would lose that (lane rm --force drops it on purpose)`);
  if (!opts.yes) return log(`${lane.name} (${lane.stateText()}) can be freed. Run again with --yes.`);
  log(lane.giveBack(true));
}

/** A port of this slot's range: the usual port + slot × LANE_PORT_STRIDE + offset. */
export function cmdPort(base: number, offset: number): void {
  let slot: number | null = null;
  try {
    slot = findLane().slot;
  } catch {
    console.error('lane: not in a slot; the usual port');
  }
  console.log(String(base + (slot ?? 0) * config.portStride + offset));
}

/** Prints what an agent working in a lane must know. */
export function cmdBrief(name?: string): void {
  const lane = findLane(name);
  const others = Lane.of(lane.clone).filter((l) => l.name !== lane.name).map((l) => l.dir);
  process.stdout.write(briefText({
    lane: lane.name,
    path: lane.dir,
    branch: lane.branch || '(detached)',
    repo: lane.clone.name,
    mainClone: lane.clone.dir,
    others,
    checks: checksFor(lane.clone, lane),
    slot: lane.slot,
    lease: lane.lease(),
    stride: config.portStride,
    sparse: currentDirs(lane),
  }));
}
