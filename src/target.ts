// Where a lane's HEAD goes: each kind knows how to make a new worktree there and how to move
// a reused slot there.
import type { Checkout, MainClone } from './checkout.ts';
import { FAST } from './config.ts';
import { tryRun } from './proc.ts';
import { log } from './text.ts';

export abstract class Target {
  abstract describe(): string;
  /** `git worktree add` arguments after the lock options. */
  protected abstract addArgs(dest: string): string[];
  /** `git switch` arguments. */
  protected abstract switchArgs(): string[];

  /** A new worktree at `dest`, locked from its first moment. */
  add(clone: MainClone, dest: string, reason: string): void {
    clone.git(...FAST, 'worktree', 'add', '--lock', '--reason', reason, ...this.addArgs(dest));
  }

  /** Moves a free slot (clean, detached or on an old branch) here. */
  switchIn(slot: Checkout): void {
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

/** A branch that exists locally only (a fork's pull request, fetched). */
class LocalBranch extends Target {
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
  const info = JSON.parse(out) as { headRefName: string; isCrossRepository: boolean; state: string };
  const branch = info.isCrossRepository ? `pr-${opts.pr}` : info.headRefName;
  if (clone.hasRef(`refs/heads/${branch}`)) throw new Error(`branch ${branch} is already checked out or exists in ${clone.name}`);
  log(`pull request #${opts.pr} (${info.state.toLowerCase()})${info.isCrossRepository ? ', from a fork: pushing needs the fork' : ''}`);
  if (!info.isCrossRepository) {
    clone.git('fetch', 'origin', '--quiet', branch);
    return new PrBranch(branch);
  }
  clone.git('fetch', 'origin', '--quiet', `pull/${opts.pr}/head:${branch}`);
  return new LocalBranch(branch);
}
