// Where a lane's HEAD goes: each kind knows how to make a new worktree there and how to move
// a reused slot there.
import path from 'node:path';
import { Checkout, type MainClone } from './checkout.ts';
import { FAST } from './config.ts';
import { addWorkspace, forgetWorkspace } from './jj.ts';
import { tryRun } from './proc.ts';
import { applySparse } from './sparse.ts';
import { log } from './text.ts';

/** Why a jj workspace gets every file: jj would record the files sparse checkout leaves out as deleted. */
export const JJ_NO_SPARSE = 'sparse slots are not supported in a jj repository (jj would see the left-out files ' +
  'as deleted): run lane new with --no-sparse';

export abstract class Target {
  abstract describe(): string;
  /** `git worktree add` arguments after the lock options. */
  protected abstract addArgs(dest: string): string[];
  /** `git switch` arguments. */
  protected abstract switchArgs(): string[];

  /**
   * A new worktree at `dest`, locked from its first moment. With `dirs` it starts empty, is
   * limited to those folders, and only then gets its files: a big repository is never
   * checked out whole first.
   */
  add(clone: MainClone, dest: string, reason: string, dirs: readonly string[] = []): void {
    if (clone.jj()) return this.addJj(clone, dest, reason, dirs);
    const empty = dirs.length > 0 ? ['--no-checkout'] : [];
    clone.git(...FAST, 'worktree', 'add', '--lock', '--reason', reason, ...empty, ...this.addArgs(dest));
    if (dirs.length === 0) return;
    const slot = new Checkout(dest);
    applySparse(slot, dirs);
    slot.git(...FAST, 'read-tree', '-mu', 'HEAD');
  }

  /**
   * In a colocated jj repository: a jj workspace named after the slot, which jj makes as a git
   * worktree too, then locked and switched here. jj cannot lock it from its first moment; until
   * the lock a new slot is still not free (changed just now), so no other session takes it.
   */
  private addJj(clone: MainClone, dest: string, reason: string, dirs: readonly string[]): void {
    if (dirs.length > 0) throw new Error(JJ_NO_SPARSE);
    const name = path.basename(dest);
    addWorkspace(clone.dir, dest, name);
    clone.jjChanged();
    try {
      clone.git('worktree', 'lock', '--reason', reason, dest);
      this.switchIn(new Checkout(dest));
    } catch (e) {
      clone.tryGit('worktree', 'unlock', dest);
      forgetWorkspace(clone.dir, name);
      clone.tryGit('worktree', 'remove', '--force', dest);
      clone.tryGit('worktree', 'prune');
      clone.jjChanged();
      throw e;
    }
  }

  /**
   * Moves a free slot (clean, detached or on an old branch) here, limited to `dirs` or whole
   * again. The folders are set first, so the switch writes only what the task gets.
   */
  switchIn(slot: Checkout, dirs: readonly string[] = []): void {
    applySparse(slot, dirs);
    slot.git(...FAST, 'switch', ...this.switchArgs());
  }
}

/** A new branch with no upstream: it must not push into the base branch by accident. */
class NewBranch extends Target {
  readonly branch: string;
  readonly start: string;

  constructor(branch: string, start: string) {
    super();
    this.branch = branch;
    this.start = start;
  }

  describe(): string {
    return `branch ${this.branch} from ${this.start}`;
  }

  protected addArgs(dest: string): string[] {
    return ['--no-track', '-b', this.branch, dest, this.start];
  }

  protected switchArgs(): string[] {
    return ['--no-track', '-c', this.branch, this.start];
  }
}

/** A pull request's branch in this repository, tracking it so pushes go back to the PR. */
class PrBranch extends Target {
  readonly branch: string;

  constructor(branch: string) {
    super();
    this.branch = branch;
  }

  describe(): string {
    return `branch ${this.branch}, tracking origin/${this.branch}`;
  }

  protected addArgs(dest: string): string[] {
    return ['--track', '-b', this.branch, dest, `origin/${this.branch}`];
  }

  protected switchArgs(): string[] {
    return ['--track', '-c', this.branch, `origin/${this.branch}`];
  }
}

/** A branch that exists locally (a fork's pull request, fetched; a slot made again elsewhere). */
export class LocalBranch extends Target {
  readonly branch: string;

  constructor(branch: string) {
    super();
    this.branch = branch;
  }

  describe(): string {
    return `local branch ${this.branch}`;
  }

  protected addArgs(dest: string): string[] {
    return [dest, this.branch];
  }

  protected switchArgs(): string[] {
    return [this.branch];
  }
}

/** No branch: a checkout at a commit (lane verify). */
export class Detached extends Target {
  readonly ref: string;

  constructor(ref: string) {
    super();
    this.ref = ref;
  }

  describe(): string {
    return `detached at ${this.ref}`;
  }

  protected addArgs(dest: string): string[] {
    return ['--detach', dest, this.ref];
  }

  protected switchArgs(): string[] {
    return ['--detach', this.ref];
  }
}

export interface TargetOptions {
  base?: string;
  branch?: string;
  pr?: number;
}

/** What a new lane checks out: a new branch for the task, or a pull request's branch. */
export function targetFor(clone: MainClone, task: string, opts: TargetOptions): Target {
  if (opts.pr === undefined) {
    const branch = opts.branch || task;
    if (clone.hasRef(`refs/heads/${branch}`)) throw new Error(`branch ${branch} already exists in ${clone.name}; pick another task name or --branch`);
    const base = opts.base || clone.base();
    if (clone.hasRef(`refs/remotes/origin/${branch}`)) log(`note: origin/${branch} already exists; the lane starts from ${base}, not from it`);
    return new NewBranch(branch, `origin/${base}`);
  }
  const slug = clone.slug();
  if (!slug) throw new Error(`${clone.name}: --pr needs a GitHub origin`);
  const out = tryRun('gh', ['pr', 'view', String(opts.pr), '-R', slug, '--json', 'headRefName,isCrossRepository,state']);
  if (!out) throw new Error(`cannot read pull request #${opts.pr} of ${slug} (is gh logged in?)`);
  const info = JSON.parse(out) as PrInfo & { state: string };
  log(`pull request #${opts.pr} (${info.state.toLowerCase()})${info.isCrossRepository ? ', from a fork: pushing needs the fork' : ''}`);
  return prTarget(clone, opts.pr, info);
}

interface PrInfo {
  headRefName: string;
  isCrossRepository: boolean;
}

/**
 * Pull request `n`'s branch: tracked when it is in this repository, fetched to pr-<n> from a
 * fork. A branch is checked out in one worktree only: when it exists here already (the slot
 * where the pull request is written, say), the lane is detached at the pull request's head.
 */
export function prTarget(clone: MainClone, n: number, info: PrInfo): Target {
  const branch = info.isCrossRepository ? `pr-${n}` : info.headRefName;
  const remote = info.isCrossRepository ? `pull/${n}/head` : branch;
  if (clone.hasRef(`refs/heads/${branch}`)) {
    clone.git('fetch', 'origin', '--quiet', remote);
    const head = clone.git('rev-parse', 'FETCH_HEAD');
    const where = clone.worktrees().find((w) => w.branch === branch)?.path;
    log(`note: branch ${branch} is ${where ? `checked out in ${where}` : 'here already'}; this lane is detached at ` +
      `the pull request's head ${head.slice(0, 7)} (commits go on the branch${where ? ' there' : ''})`);
    return new Detached(head);
  }
  clone.git('fetch', 'origin', '--quiet', info.isCrossRepository ? `${remote}:${branch}` : remote);
  return info.isCrossRepository ? new LocalBranch(branch) : new PrBranch(branch);
}
