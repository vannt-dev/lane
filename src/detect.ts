// Pure helpers that read what a checkout is: its base branch, lockfiles, checks, PR state.

/** Work goes to develop when a repository has one. */
export function pickBase({ hasDevelop, originHead }: { hasDevelop: boolean; originHead: string }): string {
  if (hasDevelop) return 'develop';
  if (!originHead) throw new Error('cannot tell the default branch (origin/HEAD is not set)');
  return originHead.replace(/^origin\//, '');
}

/** `owner/name` from an origin URL (https or ssh). */
export function repoSlug(url: string): string | null {
  const m = url.trim().match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  return m ? `${m[1]}/${m[2]}` : null;
}

/** Lockfiles: when one changes, a checkout needs its dependencies installed again. */
export const LOCKFILES = ['package-lock.json', 'pnpm-lock.yaml', 'pubspec.lock', 'Cargo.lock', 'go.sum'];

/**
 * The install commands for a checkout, from the files at its root.
 * npm ci keeps install scripts on purpose: `prepare` sets up the commit hooks.
 */
export function installCommands(files: readonly string[]): string[] {
  const has = (f: string) => files.includes(f);
  const out: string[] = [];
  if (has('pnpm-lock.yaml')) out.push('pnpm install --frozen-lockfile');
  else if (has('package-lock.json')) out.push('npm ci --no-audit --no-fund');
  if (has('pubspec.yaml')) out.push('flutter pub get');
  return out;
}

/** A stamp of the lockfiles a checkout was installed from; a change means install again. */
export function installStamp(lockfiles: ReadonlyArray<{ name: string; text: string }>): string {
  let h = 0x811c9dc5;
  for (const { name, text } of [...lockfiles].sort((a, b) => a.name.localeCompare(b.name))) {
    for (const ch of `${name}\0${text.replace(/\r\n/g, '\n')}\0`) {
      h ^= ch.charCodeAt(0);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
  }
  return h.toString(16).padStart(8, '0');
}

/**
 * The commands that check a checkout (`lane verify`, `lane sync`, `lane brief`): the ones a
 * repository names (`custom`, from `.lanecheck` or `--cmd`), else what the checkout has.
 */
export function checkCommands(input: {
  files: readonly string[];
  scripts?: Readonly<Record<string, string>>;
  custom?: readonly string[];
}): string[] {
  if (input.custom && input.custom.length > 0) return [...input.custom];
  const has = (f: string) => input.files.includes(f);
  const out: string[] = [];
  if (has('package.json')) {
    const pm = has('pnpm-lock.yaml') ? 'pnpm' : 'npm';
    for (const s of ['typecheck', 'lint', 'test']) if (input.scripts?.[s]) out.push(`${pm} run ${s}`);
  }
  if (has('pubspec.yaml')) out.push('flutter analyze', 'flutter test');
  if (has('Cargo.toml')) out.push('cargo test');
  if (has('go.mod')) out.push('go test ./...');
  return out;
}

/** The git hooks a lane may wrap, and those heavy enough to wait for a build slot. */
export const HOOK_NAMES = [
  'applypatch-msg', 'pre-applypatch', 'post-applypatch', 'pre-commit', 'pre-merge-commit',
  'prepare-commit-msg', 'commit-msg', 'post-commit', 'pre-rebase', 'post-checkout', 'post-merge',
  'pre-push', 'post-rewrite', 'reference-transaction', 'push-to-checkout', 'pre-auto-gc',
];
export const HEAVY_HOOKS = ['pre-push'];

export interface Check {
  conclusion?: string | null;
  state?: string | null;
  status?: string | null;
}

export type ChecksState = 'none' | 'pass' | 'pending' | 'fail';

const FAILED = ['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED'];
const WAITING = ['', 'PENDING', 'QUEUED', 'IN_PROGRESS', 'EXPECTED', 'WAITING'];

/** One word for a PR's checks. */
export function checksState(rollup: readonly Check[] | null | undefined): ChecksState {
  if (!rollup || rollup.length === 0) return 'none';
  const states = rollup.map((c) => String(c.conclusion || c.state || c.status || '').toUpperCase());
  if (states.some((s) => FAILED.includes(s))) return 'fail';
  if (states.some((s) => WAITING.includes(s))) return 'pending';
  return 'pass';
}
