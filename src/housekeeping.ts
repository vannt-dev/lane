// Looking after all lanes: list them, clean up merged ones, remove one for good.
import { MainClone } from './checkout.ts';
import { config } from './config.ts';
import { findLane } from './find.ts';
import { leftovers, rmLaneFolder } from './fsutil.ts';
import type { Pr } from './github.ts';
import { Lane } from './lane.ts';
import { currentDirs } from './sparse.ts';
import { log, printTable } from './text.ts';

export function cmdList(opts: { local: boolean }): void {
  const lanes = Lane.all();
  if (lanes.length === 0) return log(`no lanes under ${config.root}`);
  printTable(['lane', 'state', 'branch', 'local', 'PR / CI'], lanes.map((l) => {
    const pr = opts.local || !l.branch ? undefined : l.pr();
    const prText = pr === undefined ? '-' : pr ? `#${pr.number} ${pr.state.toLowerCase()} ${pr.checks}` : 'no PR';
    // A detached slot has no branch to push: its commits (verify's merges) go when it is taken again.
    const local = !l.exists ? '-' : l.branch ? `${l.dirty()} changed, ${l.ahead()} unpushed` : `${l.dirty()} changed`;
    const dirs = l.exists ? currentDirs(l) : [];
    const branch = `${l.branch || '(detached)'}${dirs.length ? ` (sparse: ${dirs.join(', ')})` : ''}`;
    const pool = l.exists ? l.meta().pool : undefined;
    return [`${l.name}${pool ? ` (${pool})` : ''}`, l.stateText(), branch, local, prText];
  }));
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
    if (act === 'give back') actions.push(() => log(l.giveBack(true)));
  }
  for (const dir of leftovers(lanes.map((l) => l.name))) {
    log(`remove     ${dir}  (folder no repository knows)`);
    actions.push(() => rmLaneFolder(dir) && log(`removed ${dir}`));
  }
  if (actions.length === 0) return log('nothing to clean');
  if (!opts.yes) return log(`\n${actions.length} item(s) to act on. Run again with --yes.`);
  for (const act of actions) act();
  for (const clone of MainClone.all().filter((c) => lanes.some((l) => l.clone.name === c.name))) clone.pull();
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
