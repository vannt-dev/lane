// A folder with a git checkout, and the main clone of a repository.
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.ts';
import { pickBase, repoSlug } from './detect.ts';
import { JJ_MIN, jjKind, jjSupported, jjVersion, jjWorkspaces, type JjWorkspace } from './jj.ts';
import { run, tryRun } from './proc.ts';
import { log } from './text.ts';
import { parseWorktrees, type Worktree } from './worktrees.ts';

/** A folder with a git checkout: the main clone of a repository, or one of its lanes. */
export class Checkout {
  readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  git(...args: string[]): string {
    return run('git', args, this.dir);
  }

  tryGit(...args: string[]): string | null {
    return tryRun('git', args, this.dir);
  }

  /** Git with `input` on its stdin (`git patch-id`). */
  tryGitInput(input: string, ...args: string[]): string | null {
    return tryRun('git', args, this.dir, input);
  }

  hasRef(ref: string): boolean {
    return this.tryGit('rev-parse', '-q', '--verify', ref) !== null;
  }

  /**
   * Uncommitted and untracked files. Without optional locks: a plain `git status` may refresh
   * and rewrite the index, and the index's time is how lane tells that someone worked in a slot.
   */
  dirty(): number {
    const status = this.tryGit('--no-optional-locks', 'status', '--porcelain') ?? '';
    return status ? status.split(/\r?\n/).length : 0;
  }

  conflicted(): string[] {
    return (this.tryGit('diff', '--name-only', '--diff-filter=U') ?? '').split(/\r?\n/).filter(Boolean);
  }

  /** This checkout's own git folder (for a worktree: `.git/worktrees/<id>` of the main clone). */
  gitDir(): string {
    return path.resolve(this.dir, this.git('rev-parse', '--git-dir'));
  }

  /** A file at the root of the checkout, or null when there is none. */
  readFile(name: string): string | null {
    const file = path.join(this.dir, name);
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  }
}

/** The main clone of a repository: a folder in the repos folder; its lanes hang off it. */
export class MainClone extends Checkout {
  readonly name: string;
  private baseBranch?: string;
  private jjOn?: boolean;
  private jjList?: JjWorkspace[];

  constructor(name: string) {
    super(path.join(config.repos, name));
    this.name = name;
    if (jjKind(this.dir) === 'separate') {
      throw new Error(`${this.dir} is a jj repository that is not colocated with git; lane works on git worktrees, ` +
        'so it needs a colocated one: run jj git colocation enable there (jj 0.46+), or clone it with jj git clone --colocate');
    }
    if (!fs.existsSync(path.join(this.dir, '.git'))) throw new Error(`no git clone at ${this.dir}`);
  }

  /**
   * Whether new slots are jj workspaces: the clone is a colocated jj repository and jj is new
   * enough to give a workspace its own git worktree. Otherwise they are plain git worktrees.
   */
  jj(): boolean {
    if (this.jjOn !== undefined) return this.jjOn;
    this.jjOn = false;
    if (jjKind(this.dir) !== 'colocated') return false;
    const v = jjVersion();
    if (!v || !jjSupported(v)) {
      const why = v ? `jj ${v.join('.')} is older than ${JJ_MIN.join('.')}` : 'jj is not on PATH';
      console.error(`lane: note: ${this.name} is a colocated jj repository, but ${why}: new slots are plain git worktrees jj does not know`);
      return false;
    }
    return (this.jjOn = true);
  }

  /** The jj workspaces of the clone (read once per run); none when it is no jj repository. */
  jjWorkspaces(): JjWorkspace[] {
    if (!this.jj()) return [];
    return (this.jjList ??= jjWorkspaces(this.dir));
  }

  /** After lane added or forgot a workspace. */
  jjChanged(): void {
    this.jjList = undefined;
  }

  /** Every main clone in the repos folder. */
  static all(): MainClone[] {
    return fs.readdirSync(config.repos, { withFileTypes: true })
      .filter((e) => e.isDirectory() && fs.existsSync(path.join(config.repos, e.name, '.git'))
        && fs.statSync(path.join(config.repos, e.name, '.git')).isDirectory())
      .map((e) => new MainClone(e.name));
  }

  fetch(): void {
    log(`fetching ${this.name}...`);
    this.git('fetch', 'origin', '--prune', '--quiet');
  }

  /** The branch lanes start from: develop when the repository has one, else the default branch. */
  base(): string {
    // asked once per run: finding origin/HEAD may go to the network
    if (this.baseBranch) return this.baseBranch;
    const hasDevelop = this.hasRef('refs/remotes/origin/develop');
    if (!hasDevelop) this.tryGit('remote', 'set-head', 'origin', '-a');
    this.baseBranch = pickBase({ hasDevelop, originHead: this.tryGit('symbolic-ref', '--short', 'refs/remotes/origin/HEAD') ?? '' });
    return this.baseBranch;
  }

  /** `owner/name` on GitHub, or null for another host. */
  slug(): string | null {
    const url = this.tryGit('remote', 'get-url', 'origin');
    return url ? repoSlug(url) : null;
  }

  worktrees(): Worktree[] {
    return parseWorktrees(this.tryGit('worktree', 'list', '--porcelain') ?? '');
  }

  /** Brings the clone up to date after lanes merged, unless it holds work of its own. */
  pull(): void {
    if (this.dirty()) return log(`${this.name}: main clone has local changes; not pulled`);
    if (this.tryGit('rev-parse', '--abbrev-ref', '@{upstream}') === null) return;
    const before = this.tryGit('rev-parse', 'HEAD');
    if (this.tryGit('pull', '--ff-only', '--quiet') === null) return log(`${this.name}: could not fast-forward; pull it by hand`);
    if (this.tryGit('rev-parse', 'HEAD') !== before) log(`${this.name}: main clone pulled to ${this.tryGit('log', '-1', '--format=%h %s')}`);
  }
}
