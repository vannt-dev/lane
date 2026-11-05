// The lane commands: take, give back, list, clean and remove slots; brief and port.
import { spawn } from 'node:child_process';
import { MainClone } from './checkout.ts';
import { checksFor } from './checks.ts';
import { config } from './config.ts';
import { leftovers, rmLaneFolder } from './fsutil.ts';
import { Lane } from './lane.ts';
import { SlotPool } from './pool.ts';
import { LaneSetup } from './setup.ts';
import { targetFor, type TargetOptions } from './target.ts';
import { briefText, log, printTable } from './text.ts';

interface NewOptions extends TargetOptions {
  install: boolean;
  open: boolean;
}

/** Takes a slot for a task (see SlotPool.take) and sets it up; returns its folder. */
export function cmdNew(repo: string, task: string | undefined, opts: NewOptions): string {
  const clone = new MainClone(repo);
  const name = task ?? (opts.pr !== undefined ? `pr-${opts.pr}` : undefined);
  if (!name) throw new Error('lane new needs a task name, or --pr <number>');
  clone.fetch();
  const target = targetFor(clone, name, opts);
  const { lane, reused } = new SlotPool(clone).take(name, target);
  log(`lane ${lane.name} (${reused ? 'reused' : 'new'} slot): ${target.describe()}, held for ${name}`);
  new LaneSetup(lane).run({ install: opts.install });
  if (opts.open) openClaude(lane.dir);
  else log(`\nnext: cd ${lane.dir} && claude   (agents: lane brief ${lane.name}; when pushed: lane done)`);
  return lane.dir;
}

function openClaude(dir: string): void {
  // a new Windows Terminal tab running Claude Code in the lane
  const child = spawn('wt.exe', ['-w', '0', 'nt', '-d', dir, 'claude'], { detached: true, stdio: 'ignore' });
  child.on('error', () => log(`could not open Windows Terminal; run: cd ${dir} && claude`));
  child.unref();
  log(`opened Claude Code in ${dir}`);
}

/** Gives a slot back once its work is safe on the remote (--force: unpushed commits stay local). */
export function cmdDone(name: string | undefined, opts: { force: boolean }): void {
  const lane = Lane.find(name);
  const dirty = lane.dirty();
  if (dirty) throw new Error(`${lane.name} has ${dirty} uncommitted change(s): commit and push them first`);
  const safe = lane.safe(lane.pr());
  if (!safe && !opts.force)
    throw new Error(`${lane.name} has ${lane.ahead()} commit(s) on no remote branch: push them, or --force to keep them on the local branch`);
  log(lane.giveBack(safe));
}

export function cmdList(opts: { local: boolean }): void {
  const lanes = Lane.all();
  if (lanes.length === 0) return log(`no lanes under ${config.root}`);
  printTable(['lane', 'state', 'branch', 'local', 'PR / CI'], lanes.map((l) => {
    const pr = opts.local || !l.branch ? undefined : l.pr();
    const prText = pr === undefined ? '-' : pr ? `#${pr.number} ${pr.state.toLowerCase()} ${pr.checks}` : 'no PR';
    return [l.name, l.stateText(), l.branch || '(detached)', l.exists ? `${l.dirty()} changed, ${l.ahead()} unpushed` : '-', prText];
  }));
}

/** Gives back the lanes whose PR merged, removes lanes whose folder is gone, then pulls. */
export function cmdClean(opts: { yes: boolean }): void {
  const lanes = Lane.all();
  const actions: Array<() => void> = [];
  for (const l of lanes.filter((x) => x.branch || !x.exists)) {
    const pr = l.exists ? l.pr() : null;
    const merged = pr?.state === 'MERGED' && l.safe(pr);
    const why = !l.exists ? 'folder missing' : !pr ? 'no PR' : merged ? `PR #${pr.number} merged` : `PR #${pr.number} ${pr.state.toLowerCase()}`;
    const act = !l.exists ? 'remove' : merged ? 'give back' : 'keep';
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
  const lane = Lane.find(name);
  if (!opts.force && lane.locked !== null)
    throw new Error(`${name} is held (${lane.locked}); give it back with lane done, or --force to remove it anyway`);
  if (!opts.force && lane.exists && (lane.dirty() || lane.ahead()))
    throw new Error(`${name} has uncommitted or unpushed work; --force drops it`);
  log(lane.remove());
}

/** The port for a dev server in this slot: the usual port plus the slot number. */
export function cmdPort(base: number): void {
  let slot: number | null = null;
  try {
    slot = Lane.find().slot;
  } catch {
    console.error('lane: not in a slot; the usual port');
  }
  console.log(String(base + (slot ?? 0)));
}

/** Prints what an agent working in a lane must know. */
export function cmdBrief(name?: string): void {
  const lane = Lane.find(name);
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
  }));
}
