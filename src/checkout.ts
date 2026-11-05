// A folder with a git checkout, and the main clone of a repository.
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.ts';
import { pickBase, repoSlug } from './detect.ts';
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

  hasRef(ref: string): boolean {
    return this.tryGit('rev-parse', '-q', '--verify', ref) !== null;
  }

  /** Uncommitted and untracked files. */
  dirty(): number {
    const status = this.tryGit('status', '--porcelain') ?? '';
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

  constructor(name: string) {
    super(path.join(config.repos, name));
    this.name = name;
    if (!fs.existsSync(path.join(this.dir, '.git'))) throw new Error(`no git clone at ${this.dir}`);
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
    const hasDevelop = this.hasRef('refs/remotes/origin/develop');
    if (!hasDevelop) this.tryGit('remote', 'set-head', 'origin', '-a');
    return pickBase({ hasDevelop, originHead: this.tryGit('symbolic-ref', '--short', 'refs/remotes/origin/HEAD') ?? '' });
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
