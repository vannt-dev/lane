// Several lanes of one repository together: before a merge (verify) and after one (sync).
import path from 'node:path';
import { MainClone } from './checkout.ts';
import { checksFor, runChecks } from './checks.ts';
import { NO_HOOKS } from './config.ts';
import { LOCKFILES } from './detect.ts';
import { Lane } from './lane.ts';
import { SlotPool } from './pool.ts';
import { LaneSetup } from './setup.ts';
import { Detached } from './target.ts';
import { log, printTable } from './text.ts';

interface IntegrateOptions {
  cmds?: string[];
}

/** One repository's open lanes (on a branch: a detached slot holds no task) and its base. */
class Integration {
  readonly clone: MainClone;
  readonly base: string;
  readonly lanes: Lane[];

  constructor(repo: string) {
    this.clone = new MainClone(repo);
    this.clone.fetch();
    this.base = `origin/${this.clone.base()}`;
    this.lanes = Lane.of(this.clone).filter((l) => l.branch && l.exists);
  }

  /**
   * Merges every open lane on top of the base in a pool slot (its dependencies are often
   * installed already) and runs the checks: lanes can merge cleanly as text and still break
   * each other. A failure keeps the slot held, to look at.
   */
  verify(opts: IntegrateOptions & { keep: boolean }): number {
    const { lane: slot } = new SlotPool(this.clone).take('verify', new Detached(this.base));
    log(`verifying in ${slot.name}`);
    const rows: string[][] = [];
    const merged: string[] = [];
    for (const l of this.lanes) {
      if (slot.tryGit(...NO_HOOKS, 'merge', '--no-ff', '--no-edit', l.branch) !== null) {
        merged.push(l.branch);
        rows.push([l.name, l.branch, 'merged']);
        continue;
      }
      const files = slot.conflicted();
      slot.tryGit('merge', '--abort');
      rows.push([l.name, l.branch, `CONFLICT with ${merged.join(', ') || this.base}: ${files.join(', ') || '?'}`]);
    }
    printTable(['lane', 'branch', `on ${this.base}`], rows);
    if (merged.length === 0) return this.finishVerify(slot, false, opts.keep, 'nothing merged, nothing to check');
    new LaneSetup(slot).install();
    const result = runChecks(slot, checksFor(this.clone, slot, opts.cmds));
    const conflicts = rows.length - merged.length;
    const ok = result.ok && conflicts === 0;
    const together = `${merged.length} lane(s) together on ${this.base}`;
    const msg = result.ok
      ? `${together}: checks pass${conflicts ? `; ${conflicts} lane(s) conflict` : ''}`
      : `${together}: "${result.failed}" FAILS. Each lane may pass on its own: they break each other.`;
    return this.finishVerify(slot, ok, opts.keep, msg);
  }

  /** Back to a clean base and given back when all is well; kept, held for verify, otherwise. */
  private finishVerify(slot: Lane, ok: boolean, keep: boolean, msg: string): number {
    log(`\n${msg}`);
    if (ok && !keep) {
      slot.tryGit('reset', '--hard', '--quiet', this.base);
      slot.tryGit('clean', '-fd', '--quiet');
      log(slot.giveBack(true));
    } else {
      log(`the combined checkout stays in ${slot.name}, held for verify (give it back: lane done ${slot.name} --force)`);
    }
    return ok ? 0 : 1;
  }

  /**
   * After a lane merged: moves every other open lane onto the new base and runs its checks
   * again, since a lane that passed before can fail on top of what just merged.
   */
  sync(opts: IntegrateOptions & { push: boolean }): number {
    const results = this.lanes.map((l) => ({ lane: l.name, ...this.syncOne(l, opts) }));
    printTable(['lane', `onto ${this.base}`], results.map((r) => [r.lane, r.note]));
    return results.some((r) => r.bad) ? 1 : 0;
  }

  private syncOne(l: Lane, opts: IntegrateOptions & { push: boolean }): { note: string; bad?: boolean } {
    const dirty = l.dirty();
    if (dirty) return { note: `skipped: ${dirty} uncommitted change(s)` };
    const pr = l.pr();
    if (pr?.state === 'MERGED') return { note: `skipped: PR #${pr.number} merged (lane clean gives it back)` };
    const users = l.inUse();
    if (users.length > 0) return { note: `skipped: in use (${users.join(', ')})` };
    if (l.tryGit('merge-base', '--is-ancestor', this.base, 'HEAD') !== null) return { note: `already on ${this.base}` };
    if (l.tryGit('merge-base', this.base, 'HEAD') === null)
      return { note: `skipped: no history in common with ${this.base} (rewritten?); move the work by hand`, bad: true };
    const before = l.git('rev-parse', 'HEAD');
    if (l.tryGit(...NO_HOOKS, 'rebase', this.base) === null) {
      const files = l.conflicted();
      l.tryGit('rebase', '--abort');
      return { note: `CONFLICT, left as it was: ${files.join(', ') || '?'} (rebase by hand)`, bad: true };
    }
    const changed = (l.tryGit('diff', '--name-only', before, 'HEAD') ?? '').split(/\r?\n/);
    if (changed.some((f) => LOCKFILES.includes(path.basename(f)))) new LaneSetup(l).install();
    const result = runChecks(l, checksFor(this.clone, l, opts.cmds));
    if (!result.ok) return { note: `rebased; "${result.failed}" FAILS on top of ${this.base}`, bad: true };
    if (!l.hasRef(`refs/remotes/origin/${l.branch}`)) return { note: 'rebased, checks pass' };
    if (!opts.push) return { note: 'rebased, checks pass; push with --force-with-lease (or lane sync --push)' };
    const pushed = l.tryGit('push', '--force-with-lease', 'origin', l.branch) !== null;
    return { note: `rebased, checks pass, ${pushed ? 'pushed' : 'PUSH FAILED'}`, bad: !pushed };
  }
}

export function cmdVerify(repo: string, opts: IntegrateOptions & { keep: boolean }): number {
  const it = new Integration(repo);
  if (it.lanes.length === 0) return (log(`${repo} has no lanes`), 0);
  return it.verify(opts);
}

export function cmdSync(repo: string, opts: IntegrateOptions & { push: boolean }): number {
  const it = new Integration(repo);
  if (it.lanes.length === 0) return (log(`${repo} has no lanes`), 0);
  return it.sync(opts);
}
