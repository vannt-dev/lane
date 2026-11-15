// Several lanes of one repository together: before a merge (verify) and after one (sync).
import path from 'node:path';
import { MainClone } from './checkout.ts';
import { checksFor, runChecks } from './checks.ts';
import { NO_HOOKS } from './config.ts';
import { LOCKFILES } from './detect.ts';
import { Lane } from './lane.ts';
import { SlotPool } from './pool.ts';
import { LaneSetup } from './setup.ts';
import { currentDirs } from './sparse.ts';
import { Detached } from './target.ts';
import { log, printTable } from './text.ts';

interface IntegrateOptions {
  cmds?: string[];
}

interface VerifyOptions extends IntegrateOptions {
  keep: boolean;
  /** Failing combined checks: look for the lanes to blame (default); false with `--no-bisect`. */
  bisect?: boolean;
  /** The most extra check runs that search may take (`--bisect-max`). */
  bisectMax?: number;
}

/** Extra check runs a failing verify may take by default: four lanes alone, and their six pairs. */
export const BISECT_MAX = 10;

/** A lane as the result names it: its folder and its branch. */
const label = (l: Lane) => `${l.name} (${l.branch})`;

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
   * each other. A conflict names the lanes that do not merge together; failing checks start
   * the search for the lanes to blame (see blame). A failure keeps the slot held, to look at.
   */
  verify(opts: VerifyOptions): number {
    const { lane: slot } = new SlotPool(this.clone).take('verify', new Detached(this.base));
    log(`verifying in ${slot.name}`);
    const merged: Lane[] = [];
    const conflicts: Array<{ lane: Lane; files: string[] }> = [];
    for (const l of this.lanes) {
      const files = this.merge(slot, l);
      if (files) conflicts.push({ lane: l, files });
      else merged.push(l);
    }
    const combined = slot.git('rev-parse', 'HEAD');
    const rows = this.lanes.map((l) => {
      const c = conflicts.find((x) => x.lane === l);
      return [l.name, l.branch, c ? this.conflictText(slot, l, c.files) : 'merged'];
    });
    if (conflicts.length > 0) this.restore(slot, combined);
    printTable(['lane', 'branch', `on ${this.base}`], rows);
    if (merged.length === 0) return this.finishVerify(slot, false, opts.keep, 'nothing merged, nothing to check');
    const result = this.check(slot, opts);
    const together = `${merged.length} lane(s) together on ${this.base}`;
    if (result.ok) {
      const msg = `${together}: checks pass${conflicts.length ? `; ${conflicts.length} lane(s) conflict` : ''}`;
      return this.finishVerify(slot, conflicts.length === 0, opts.keep, msg);
    }
    const max = opts.bisect === false ? 0 : opts.bisectMax ?? BISECT_MAX;
    const fails = `${together}: "${result.failed}" FAILS.`;
    if (max <= 0) return this.finishVerify(slot, false, opts.keep, `${fails} Each lane may pass on its own: they break each other.`);
    log(`\n${fails} Looking for the lanes to blame, in at most ${max} more check run(s) (--bisect-max; --no-bisect skips this)`);
    const found = this.blame(slot, merged, max, opts);
    this.restore(slot, combined);
    log('');
    printTable(['lanes', 'checks'], found.rows);
    return this.finishVerify(slot, false, opts.keep, `${fails}\n${found.verdict.join('\n')}`);
  }

  /** Merges a lane into the slot; the files in conflict when it does not merge (the merge is undone). */
  private merge(slot: Lane, l: Lane): string[] | null {
    if (slot.tryGit(...NO_HOOKS, 'merge', '--no-ff', '--no-edit', l.branch) !== null) return null;
    const files = slot.conflicted();
    slot.tryGit('merge', '--abort');
    return files;
  }

  /** The slot on a commit (the base, or the combined merge), nothing left over from a check run. */
  private restore(slot: Lane, commit: string): void {
    slot.git('reset', '--hard', '--quiet', commit);
    slot.tryGit('clean', '-fd', '--quiet');
  }

  /** The slot on the base with only these lanes merged; false when one of them does not merge. */
  private only(slot: Lane, lanes: readonly Lane[]): boolean {
    this.restore(slot, this.base);
    return lanes.every((l) => this.merge(slot, l) === null);
  }

  private check(slot: Lane, opts: IntegrateOptions): { ok: boolean; failed?: string } {
    new LaneSetup(slot).install();
    return runChecks(slot, checksFor(this.clone, slot, opts.cmds));
  }

  /**
   * What a lane that did not merge conflicts with: the base itself, or each other lane it
   * cannot be merged with, two at a time (merges only, no check runs).
   */
  private conflictText(slot: Lane, l: Lane, files: readonly string[]): string {
    const list = (f: readonly string[]) => f.join(', ') || '?';
    this.restore(slot, this.base);
    const alone = this.merge(slot, l);
    if (alone) return `CONFLICT with ${this.base} itself: ${list(alone)} (lane sync rebases it)`;
    const pairs: string[] = [];
    for (const other of this.lanes.filter((x) => x !== l)) {
      if (!this.only(slot, [other])) continue;
      const clash = this.merge(slot, l);
      if (clash) pairs.push(`CONFLICT with ${label(other)}: ${list(clash)}`);
    }
    return pairs.length > 0 ? pairs.join('; ') : `CONFLICT only with several lanes together: ${list(files)}`;
  }

  /**
   * Which lanes make the combined checks fail, in at most `max` check runs: each lane alone on
   * the base, then, when all pass alone, each pair. Stops at the cap and says what is left.
   */
  private blame(slot: Lane, lanes: readonly Lane[], max: number, opts: IntegrateOptions): { rows: string[][]; verdict: string[] } {
    const rows: string[][] = [];
    let runs = 0;
    /** The checks with only these lanes on the base; null once the cap is reached. */
    const run = (set: readonly Lane[], what: string): { ok: boolean; failed?: string } | null => {
      if (runs >= max) return null;
      runs++;
      log(`\n-- ${what} (run ${runs} of at most ${max})`);
      if (!this.only(slot, set)) return { ok: false, failed: 'git merge' };
      return this.check(slot, opts);
    };
    const capped = (left: number) =>
      `search stopped after ${runs} extra check run(s) (--bisect-max ${max}): ${left} combination(s) not tested`;

    const [single] = lanes;
    const alone: Lane[] = [];
    let tested = 0;
    if (lanes.length === 1 && single) {
      // One lane merged: the combined run was that lane alone.
      alone.push(single);
      tested = 1;
      rows.push([label(single), 'FAIL alone (the only lane merged)']);
    } else {
      for (const l of lanes) {
        const r = run([l], `${label(l)} alone on ${this.base}`);
        if (!r) break;
        tested++;
        rows.push([label(l), r.ok ? 'pass alone' : `FAIL alone: "${r.failed}"`]);
        if (!r.ok) alone.push(l);
      }
    }
    if (alone.length > 0) {
      // Every lane failing alone is more likely the base's fault than each lane's.
      if (alone.length === lanes.length) {
        const r = run([], `${this.base} with no lane`);
        if (r) rows.push([this.base, r.ok ? 'pass' : `FAIL: "${r.failed}"`]);
        if (r && !r.ok) return { rows, verdict: [`${this.base} itself fails the checks, with no lane merged: no lane is to blame.`] };
      }
      const verdict = alone.map((l) => `${label(l)} fails by itself.`);
      if (tested < lanes.length) verdict.push(`${capped(lanes.length - tested)}.`);
      else if (lanes.length - alone.length > 1) verdict.push('Pairs were not tested: fix that first, then verify again.');
      return { rows, verdict };
    }
    if (tested < lanes.length) return { rows, verdict: [`No lane tested fails by itself; ${capped(lanes.length - tested)}.`] };

    const pairs = lanes.flatMap((a, i) => lanes.slice(i + 1).map((b) => [a, b] as const));
    const verdict: string[] = [];
    let left = 0;
    for (const [a, b] of pairs) {
      // Two lanes merged: the combined run was this pair.
      const r = lanes.length === 2 ? { ok: false } : run([a, b], `${label(a)} and ${label(b)} on ${this.base}`);
      if (!r) {
        left++;
        continue;
      }
      rows.push([`${a.name} + ${b.name}`, r.ok ? 'pass together' : `FAIL together${r.failed ? `: "${r.failed}"` : ''}`]);
      if (!r.ok) verdict.push(`${label(a)} and ${label(b)} break each other: each passes alone, together they fail.`);
    }
    if (left > 0) verdict.push(`${verdict.length ? 'More pairs may fail' : 'Every lane passes alone and no pair tested fails'}; ${capped(left)}.`);
    if (verdict.length > 0) return { rows, verdict };
    rows.push([lanes.map((l) => l.name).join(' + '), 'FAIL together']);
    const all = lanes.length === 3 ? 'only with all 3 lanes together' : `only with three or more of the ${lanes.length} lanes together (not searched further)`;
    return { rows, verdict: [`Every lane passes alone and every pair passes: the checks fail ${all}.`] };
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
    // Without GitHub (no gh, another host) a squash-merged lane would be rebased and force-pushed.
    if (l.merged(pr)) return { note: `skipped: work already in ${this.base} (lane clean gives it back)` };
    const users = l.inUse();
    if (users.length > 0) return { note: `skipped: in use (${users.join(', ')})` };
    if (l.tryGit('merge-base', '--is-ancestor', this.base, 'HEAD') !== null) return this.onBase(l, opts);
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
    return this.checkAndPush(l, opts, 'rebased');
  }

  /**
   * A lane already on the base. An earlier sync may have rebased it and found it failing; once
   * it is fixed, it still differs from its remote branch, so it is checked and pushed like a rebase.
   */
  private onBase(l: Lane, opts: IntegrateOptions & { push: boolean }): { note: string; bad?: boolean } {
    const remote = `refs/remotes/origin/${l.branch}`;
    if (!l.hasRef(remote) || l.git('rev-parse', 'HEAD') === l.git('rev-parse', remote)) return { note: `already on ${this.base}` };
    return this.checkAndPush(l, opts, `already on ${this.base}, not pushed yet`);
  }

  private checkAndPush(l: Lane, opts: IntegrateOptions & { push: boolean }, what: string): { note: string; bad?: boolean } {
    const result = runChecks(l, checksFor(this.clone, l, opts.cmds));
    if (!result.ok) return { note: `${what}; "${result.failed}" FAILS on top of ${this.base}`, bad: true };
    // A sparse lane's checks see its folders only: a break elsewhere would not show.
    const pass = currentDirs(l).length > 0 ? 'checks pass on its folders only (lane verify checks the whole)' : 'checks pass';
    if (!l.hasRef(`refs/remotes/origin/${l.branch}`)) return { note: `${what}, ${pass}` };
    if (!opts.push) return { note: `${what}, ${pass}; push with --force-with-lease (or lane sync --push)` };
    const pushed = l.tryGit('push', '--force-with-lease', 'origin', l.branch) !== null;
    return { note: `${what}, ${pass}, ${pushed ? 'pushed' : 'PUSH FAILED'}`, bad: !pushed };
  }
}

export function cmdVerify(repo: string, opts: VerifyOptions): number {
  const it = new Integration(repo);
  if (it.lanes.length === 0) return (log(`${repo} has no lanes`), 0);
  return it.verify(opts);
}

export function cmdSync(repo: string, opts: IntegrateOptions & { push: boolean }): number {
  const it = new Integration(repo);
  if (it.lanes.length === 0) return (log(`${repo} has no lanes`), 0);
  return it.sync(opts);
}
