// Looking after all lanes: list them, clean up merged ones, remove one for good.
import { branchDrops } from './branches.ts';
import { MainClone } from './checkout.ts';
import { config } from './config.ts';
import { findLane } from './find.ts';
import { leftovers, rmLaneFolder } from './fsutil.ts';
import { beforeGiveBack } from './hooks.ts';
import type { Pr } from './github.ts';
import { Lane, stateText, type LaneState } from './lane.ts';
import { spareHint } from './move.ts';
import { currentDirs } from './sparse.ts';
import { log, printTable } from './text.ts';

/** One lane as `lane list` knows it; `lane list --json` prints these, the table is made from them. */
export interface LaneInfo {
  name: string;
  repo: string;
  /** The slot number; null for a lane folder named otherwise. */
  slot: number | null;
  path: string;
  /** The named pool the slot belongs to; null for the default pool. */
  pool: string | null;
  state: LaneState['state'];
  /** The task the lane is held for, or the last one it held. */
  task: string | null;
  lease: string | null;
  /** When the hold began (ISO 8601, UTC) and how long ago; null when not held. */
  heldSince: string | null;
  heldMs: number | null;
  abandoned: boolean;
  /** Time since anything changed in the slot. */
  idleMs: number | null;
  /** null when detached (a free slot, a verify slot). */
  branch: string | null;
  /** The folders of a sparse lane; empty when it has every file. */
  sparse: string[];
  /** Uncommitted and untracked files; null when the folder is missing. */
  changed: number | null;
  /** Commits on no remote branch; null when detached or the folder is missing. */
  unpushed: number | null;
  /** The branch's newest pull request, null when it has none; left out when not asked (--local, detached). */
  pr?: { number: number; state: string; checks: string } | null;
}

export function laneInfo(l: Lane, opts: { local: boolean }): LaneInfo {
  const s = l.state();
  const info: LaneInfo = {
    name: l.name,
    repo: l.clone.name,
    slot: l.slot,
    path: l.dir,
    pool: (l.exists ? l.meta().pool : undefined) ?? null,
    state: s.state,
    task: s.task,
    lease: s.lease,
    heldSince: s.since === null ? null : new Date(s.since).toISOString(),
    heldMs: s.since === null ? null : Math.max(0, Date.now() - s.since),
    abandoned: s.abandoned,
    idleMs: s.idleMs,
    branch: l.branch || null,
    sparse: l.exists ? currentDirs(l) : [],
    changed: l.exists ? l.dirty() : null,
    // A detached slot has no branch to push: its commits (verify's merges) go when it is taken again.
    unpushed: l.exists && l.branch ? l.ahead() : null,
  };
  if (!opts.local && l.branch) {
    const pr = l.pr();
    info.pr = pr ? { number: pr.number, state: pr.state, checks: pr.checks } : null;
  }
  return info;
}

function tableRow(i: LaneInfo): string[] {
  const prText = i.pr === undefined ? '-' : i.pr ? `#${i.pr.number} ${i.pr.state.toLowerCase()} ${i.pr.checks}` : 'no PR';
  const local = i.changed === null ? '-' : `${i.changed} changed${i.unpushed === null ? '' : `, ${i.unpushed} unpushed`}`;
  const branch = `${i.branch ?? '(detached)'}${i.sparse.length ? ` (sparse: ${i.sparse.join(', ')})` : ''}`;
  return [`${i.name}${i.pool ? ` (${i.pool})` : ''}`, stateText({ ...i, since: i.heldSince === null ? null : Date.parse(i.heldSince) }), branch, local, prText];
}

/** Every lane, as a table; `json`: as one JSON array on stdout and nothing else, for scripts and agents. */
export function cmdList(opts: { local: boolean; json?: boolean }): void {
  const lanes = Lane.all().map((l) => laneInfo(l, opts));
  if (opts.json) return log(JSON.stringify(lanes, null, 2));
  if (lanes.length === 0) return log(`no lanes under ${config.root}`);
  printTable(['lane', 'state', 'branch', 'local', 'PR / CI'], lanes.map(tableRow));
  spareHint(lanes);
}

/**
 * Why a lane on a branch stays or goes; merged means its PR merged here, or the base has it.
 * A merged lane still held stays (follow-up rounds reuse it) unless the hold looks abandoned
 * or `force`; one with a claim or a process in it always stays.
 */
function verdict(l: Lane, pr: Pr | null, force: boolean): { act: 'give back' | 'keep'; why: string } {
  const merged = l.dirty() === 0 && l.merged(pr);
  const prText = pr ? `PR #${pr.number} ${pr.state.toLowerCase()}` : 'no PR';
  if (!merged) return { act: 'keep', why: prText };
  const done = pr?.state === 'MERGED' ? prText : `${prText}, work already in origin/${l.clone.base()}`;
  if (l.locked !== null && !force && !l.abandoned())
    return { act: 'keep', why: `${done}; still held for ${l.task()}: lane done ${l.name}, or lane clean --force` };
  const users = l.inUse();
  if (users.length > 0) return { act: 'keep', why: `${done}; in use: ${users.join(', ')}` };
  return { act: 'give back', why: done };
}

/**
 * Gives back the lanes whose work merged (found through GitHub, or offline from the base
 * branch), removes lanes whose folder is gone and leftover folders, then pulls the main clones.
 */
export function cmdClean(opts: { yes: boolean; force: boolean }): void {
  const lanes = Lane.all();
  for (const clone of new Set(lanes.filter((l) => l.branch).map((l) => l.clone))) clone.fetch();
  const actions: Array<() => void> = [];
  for (const l of lanes.filter((x) => x.branch || !x.exists)) {
    const { act, why } = l.exists ? verdict(l, l.pr(), opts.force) : { act: 'remove', why: 'folder missing' };
    log(`${act.padEnd(9)}  ${l.name}  (${why})`);
    if (act === 'remove') actions.push(() => log(l.remove()));
    if (act === 'give back') actions.push(() => giveBack(l));
  }
  actions.push(...branchDrops(lanes));
  for (const dir of leftovers(lanes.map((l) => l.name))) {
    log(`remove     ${dir}  (folder no repository knows)`);
    actions.push(() => rmLaneFolder(dir) && log(`removed ${dir}`));
  }
  if (actions.length === 0) return log('nothing to clean');
  if (!opts.yes) return log(`\n${actions.length} item(s) to act on. Run again with --yes.`);
  for (const act of actions) act();
  for (const clone of MainClone.all().filter((c) => lanes.some((l) => l.clone.name === c.name))) clone.pull();
}

/** Gives a merged lane back after its `preDone` commands; one that fails stays, the rest go on. */
function giveBack(l: Lane): void {
  try {
    beforeGiveBack(l);
  } catch (e) {
    return log(`kept       ${l.name}  (${e instanceof Error ? e.message : String(e)})`);
  }
  log(l.giveBack(true));
}

/** Deletes a slot for good, folder and caches included. */
export function cmdRemove(name: string, opts: { force: boolean }): void {
  const lane = findLane(name);
  if (!opts.force && lane.locked !== null)
    throw new Error(`${name} is held (${lane.locked}); give it back with lane done, or --force to remove it anyway`);
  if (!opts.force && lane.exists && (lane.dirty() || lane.ahead()))
    throw new Error(`${name} has uncommitted or unpushed work; --force drops it`);
  log(lane.remove());
}
