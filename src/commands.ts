import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { errCode, git, gitTry, runLive, sleepMs, tryRun } from './sh.ts';
import { Locks, type Holder } from './locks.ts';
import {
  briefText, checkCommands, checksState, cleanable, HEAVY_HOOKS, HOOK_NAMES, hookWrapper, installCommands,
  isInside, lanePath, listLines, LOCKFILES, parseWorktrees, pickBase, repoSlug, samePath,
  type ChecksState, type Check, type Worktree,
} from './core.ts';

export const config = {
  root: process.env.LANE_ROOT || 'F:/wt',
  repos: process.env.LANE_REPOS || 'F:/ai-agent',
};

interface Lane extends Worktree {
  repo: string;
  repoDir: string;
  name: string;
}

interface LocalState {
  dirty: number;
  unpushed: boolean;
  ahead: number;
  missing: boolean;
}

interface Pr {
  number: number;
  state: string;
  checks: ChecksState;
  /** The last commit of the PR's branch. */
  head: string;
}

const log = (msg: string) => console.log(msg);

// Untracked files worth carrying over from the main clone. A repo can add more,
// one path per line, in an untracked `.lanecopy` file at its root.
const COPY_DEFAULT = ['.env', '.env.local', 'android/key.properties', '.claude/settings.local.json'];

function repoDir(repo: string): string {
  const dir = path.join(config.repos, repo);
  if (!fs.existsSync(path.join(dir, '.git'))) throw new Error(`no git clone at ${dir}`);
  return dir;
}

function baseBranch(dir: string): string {
  const hasDevelop = gitTry(dir, 'rev-parse', '-q', '--verify', 'refs/remotes/origin/develop') !== null;
  if (!hasDevelop) gitTry(dir, 'remote', 'set-head', 'origin', '-a');
  const originHead = gitTry(dir, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD') ?? '';
  return pickBase({ hasDevelop, originHead });
}

/** An untracked list file at the root of the main clone (`.lanecopy`, `.lanecheck`). */
function readListFile(dir: string, name: string): string[] {
  const file = path.join(dir, name);
  return fs.existsSync(file) ? listLines(fs.readFileSync(file, 'utf8')) : [];
}

function isTracked(dir: string, file: string): boolean {
  return gitTry(dir, 'ls-files', '--error-unmatch', '--', file) !== null;
}

export interface NewOptions {
  base?: string;
  branch?: string;
  /** Open the lane on an existing pull request's branch. */
  pr?: number;
  install: boolean;
  open: boolean;
}

function freeDest(dest: string): void {
  if (!fs.existsSync(dest)) return;
  if (fs.readdirSync(dest).length > 0) throw new Error(`${dest} already exists`);
  fs.rmdirSync(dest);
}

const branchExists = (dir: string, branch: string) =>
  gitTry(dir, 'rev-parse', '-q', '--verify', `refs/heads/${branch}`) !== null;

/** Checks out a pull request's branch in a new lane: its own branch when it is in this repo. */
function addPrWorktree(dir: string, repo: string, pr: number, dest: string): void {
  const url = gitTry(dir, 'remote', 'get-url', 'origin');
  const slug = url && repoSlug(url);
  if (!slug) throw new Error(`${repo}: --pr needs a GitHub origin`);
  const out = tryRun('gh', ['pr', 'view', String(pr), '-R', slug, '--json', 'headRefName,isCrossRepository,state']);
  if (!out) throw new Error(`cannot read pull request #${pr} of ${slug} (is gh logged in?)`);
  const info = JSON.parse(out) as { headRefName: string; isCrossRepository: boolean; state: string };
  if (info.isCrossRepository) {
    // A fork's branch cannot be pushed from here: take the pull request's commits on a local branch.
    const local = `pr-${pr}`;
    if (branchExists(dir, local)) throw new Error(`branch ${local} already exists in ${repo}`);
    git(dir, 'fetch', 'origin', '--quiet', `pull/${pr}/head:${local}`);
    git(dir, 'worktree', 'add', dest, local);
    log(`lane ${path.basename(dest)}: pull request #${pr} from a fork, on local branch ${local} (pushing needs the fork)`);
    return;
  }
  const branch = info.headRefName;
  if (branchExists(dir, branch)) throw new Error(`branch ${branch} is already checked out or exists in ${repo}`);
  git(dir, 'fetch', 'origin', '--quiet', branch);
  git(dir, 'worktree', 'add', '--track', '-b', branch, dest, `origin/${branch}`);
  log(`lane ${path.basename(dest)}: pull request #${pr} (${info.state.toLowerCase()}) on its branch ${branch}`);
}

export function cmdNew(repo: string, task: string | undefined, opts: NewOptions): void {
  const dir = repoDir(repo);
  const name = task ?? (opts.pr !== undefined ? `pr-${opts.pr}` : undefined);
  if (!name) throw new Error('lane new needs a task name, or --pr <number>');
  const dest = lanePath(config.root, repo, name);
  freeDest(dest);

  log(`fetching ${repo}...`);
  git(dir, 'fetch', 'origin', '--prune', '--quiet');
  fs.mkdirSync(config.root, { recursive: true });
  if (opts.pr !== undefined) {
    addPrWorktree(dir, repo, opts.pr, dest);
  } else {
    const branch = opts.branch || name;
    if (branchExists(dir, branch))
      throw new Error(`branch ${branch} already exists in ${repo}; pick another task name or --branch`);
    const base = opts.base || baseBranch(dir);
    if (gitTry(dir, 'rev-parse', '-q', '--verify', `refs/remotes/origin/${branch}`) !== null)
      log(`note: origin/${branch} already exists; the lane starts from ${base}, not from it`);
    // --no-track: the new branch must not push into the base branch by accident.
    git(dir, 'worktree', 'add', '--no-track', '-b', branch, dest, `origin/${base}`);
    log(`lane ${path.basename(dest)}: branch ${branch} from origin/${base}`);
  }

  prepare(dir, dest, { install: opts.install });
  writeLaneNotes(dest);
  wrapHeavyHooks(dir, dest);

  if (opts.open) openClaude(dest);
  else log(`\nnext: cd ${dest} && claude      (or: lane new ... --open; agents: lane brief ${path.basename(dest)})`);
}

/** Submodules, untracked local files and dependencies: what a fresh worktree lacks. */
function prepare(dir: string, dest: string, opts: { install: boolean }): void {
  if (fs.existsSync(path.join(dest, '.gitmodules'))) {
    log('fetching submodules...');
    if (!runLive('git submodule update --init --recursive', dest))
      log('WARNING: submodules did not load (private core needs access); the build may fail');
  }
  for (const file of [...COPY_DEFAULT, ...readListFile(dir, '.lanecopy')]) {
    const from = path.join(dir, file);
    if (!fs.existsSync(from) || !fs.statSync(from).isFile() || isTracked(dir, file)) continue;
    fs.mkdirSync(path.dirname(path.join(dest, file)), { recursive: true });
    fs.copyFileSync(from, path.join(dest, file));
    log(`copied ${file}`);
  }
  if (opts.install) install(dest);
}

function install(dest: string): void {
  for (const c of installCommands(fs.readdirSync(dest))) {
    log(`> ${c}`);
    if (!runLive(c, dest)) throw new Error(`"${c}" failed in ${dest}; the lane is kept, fix and rerun it there`);
  }
}

/**
 * Gives the lane its own hooks folder, where a heavy hook (pre-push runs the whole test suite)
 * waits for a build slot and every other hook runs as before. Only this worktree uses it.
 */
function wrapHeavyHooks(dir: string, dest: string): void {
  const original = path.resolve(dest, git(dest, 'rev-parse', '--git-path', 'hooks'));
  if (!fs.existsSync(original)) return;
  const hooks = fs.readdirSync(original).filter((h) => HOOK_NAMES.includes(h) && fs.statSync(path.join(original, h)).isFile());
  if (!hooks.some((h) => HEAVY_HOOKS.includes(h))) return;
  const own = path.resolve(dest, git(dest, 'rev-parse', '--git-dir'), 'lane-hooks');
  fs.mkdirSync(own, { recursive: true });
  for (const h of hooks) fs.writeFileSync(path.join(own, h), hookWrapper(h, path.join(original, h)), { mode: 0o755 });
  git(dir, 'config', 'extensions.worktreeConfig', 'true');
  git(dest, 'config', '--worktree', 'core.hooksPath', own);
  log(`hooks: ${hooks.filter((h) => HEAVY_HOOKS.includes(h)).join(', ')} wait for a build slot in this lane`);
}

function openClaude(dir: string): void {
  // A new Windows Terminal tab running Claude Code in the lane.
  const child = spawn('wt.exe', ['-w', '0', 'nt', '-d', dir, 'claude'], { detached: true, stdio: 'ignore' });
  child.on('error', () => log(`could not open Windows Terminal; run: cd ${dir} && claude`));
  child.unref();
  log(`opened Claude Code in ${dir}`);
}

/**
 * Whether a path is under the lane root. Git prints long paths; the root may be given in another
 * form of the same folder (a Windows 8.3 short name such as RUNNER~1, a symlink), so compare both.
 */
function underRoot(p: string): boolean {
  if (isInside(p, config.root)) return true;
  try {
    return isInside(p, fs.realpathSync.native(config.root));
  } catch {
    return false;
  }
}

/** Every lane under the lane root, across all clones in the repos folder. */
export function findLanes(): Lane[] {
  const lanes: Lane[] = [];
  for (const name of fs.readdirSync(config.repos)) {
    const dir = path.join(config.repos, name);
    const dotGit = path.join(dir, '.git');
    if (!fs.existsSync(dotGit) || !fs.statSync(dotGit).isDirectory()) continue;
    const out = gitTry(dir, 'worktree', 'list', '--porcelain');
    if (!out) continue;
    for (const w of parseWorktrees(out)) {
      if (!underRoot(w.path)) continue;
      lanes.push({ repo: name, repoDir: dir, ...w, name: path.basename(w.path) });
    }
  }
  return lanes;
}

function localState(lane: Lane): LocalState {
  if (!fs.existsSync(lane.path)) return { dirty: 0, unpushed: false, ahead: 0, missing: true };
  const status = gitTry(lane.path, 'status', '--porcelain') ?? '';
  const dirty = status ? status.split(/\r?\n/).length : 0;
  // Commits that are on no remote branch at all.
  const ahead = Number(gitTry(lane.path, 'rev-list', '--count', 'HEAD', '--not', '--remotes=origin') ?? '0');
  return { dirty, unpushed: ahead > 0, ahead, missing: false };
}

function prOf(lane: Lane): Pr | null {
  const url = gitTry(lane.repoDir, 'remote', 'get-url', 'origin');
  const slug = url && repoSlug(url);
  if (!slug || !lane.branch) return null;
  const out = tryRun('gh', ['pr', 'list', '-R', slug, '--head', lane.branch, '--state', 'all', '--limit', '1',
    '--json', 'number,state,statusCheckRollup,headRefOid']);
  if (!out) return null;
  const [pr] = JSON.parse(out) as { number: number; state: string; statusCheckRollup: Check[]; headRefOid: string }[];
  return pr
    ? { number: pr.number, state: pr.state, checks: checksState(pr.statusCheckRollup), head: pr.headRefOid }
    : null;
}

export function cmdList(opts: { local: boolean }): void {
  const lanes = findLanes();
  if (lanes.length === 0) return log(`no lanes under ${config.root}`);
  const rows = lanes.map((l) => {
    const s = localState(l);
    const pr = opts.local ? undefined : prOf(l);
    const prText = pr === undefined ? '-' : pr ? `#${pr.number} ${pr.state.toLowerCase()} ${pr.checks}` : 'no PR';
    const local = s.missing ? 'folder missing' : `${s.dirty} changed, ${s.ahead} unpushed`;
    return [l.name, l.branch || '(detached)', local, prText];
  });
  printTable(['lane', 'branch', 'local', 'PR / CI'], rows);
}

function printTable(head: string[], rows: string[][]): void {
  const all = [head, ...rows];
  const w = head.map((_, i) => Math.max(...all.map((r) => (r[i] ?? '').length)));
  for (const r of all) log(r.map((c, i) => c.padEnd(w[i] ?? 0)).join('  '));
}

/** Delete a folder; on Windows use the \\?\ form so long paths (node_modules, Gradle) work. */
export function rmFolder(dir: string): void {
  const target = process.platform === 'win32' ? '\\\\?\\' + path.resolve(dir) : dir;
  fs.rmSync(target, { recursive: true, force: true });
}

/** adb is often not on PATH; look in the usual Android SDK places too. */
function findAdb(): string | null {
  if (tryRun('adb', ['version']) !== null) return 'adb';
  const exe = process.platform === 'win32' ? 'adb.exe' : 'adb';
  const local = process.env.LOCALAPPDATA;
  const sdks = [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT, local && path.join(local, 'Android', 'Sdk')];
  return sdks
    .filter((s): s is string => Boolean(s))
    .map((s) => path.join(s, 'platform-tools', exe))
    .find((p) => fs.existsSync(p)) ?? null;
}

/**
 * Delete a lane folder. A program started inside the lane can keep it open after its work
 * is done; the usual one is the adb server (any `adb` command starts it there). Stopping it
 * is harmless: the emulator keeps running and the next adb command starts a new server.
 */
function rmLaneFolder(dir: string): boolean {
  // Windows may report success yet keep a folder another program still has open (it is only
  // marked for deletion), so check that it is gone instead of trusting the call.
  const gone = () => {
    try {
      rmFolder(dir);
    } catch (e) {
      if (!['EPERM', 'EBUSY', 'ENOTEMPTY'].includes(errCode(e) ?? '')) throw e;
    }
    return !fs.existsSync(dir);
  };
  if (gone()) return true;
  const adb = findAdb();
  if (adb && tryRun(adb, ['kill-server']) !== null) {
    log('the folder was in use; stopped the adb server and tried again');
    sleepMs(1000);
    if (gone()) return true;
  }
  log(`WARNING: ${dir} is still in use by a running program; close it, then run: lane clean --yes`);
  return false;
}

function removeLane(lane: Lane): void {
  if (samePath(lane.path, lane.repoDir)) throw new Error('refusing to remove a main clone');
  if (!underRoot(lane.path)) throw new Error(`${lane.path} is not under ${config.root}`);
  gitTry(lane.repoDir, 'worktree', 'remove', '--force', lane.path);
  const folderGone = !fs.existsSync(lane.path) || rmLaneFolder(lane.path);
  gitTry(lane.repoDir, 'worktree', 'prune');
  if (lane.branch) gitTry(lane.repoDir, 'branch', '-D', lane.branch);
  const what = `${lane.name}${lane.branch ? ` and local branch ${lane.branch}` : ''}`;
  log(folderGone ? `removed ${what}` : `removed ${what}; the folder itself is left (see warning)`);
}

/** Folders under the lane root that no repo knows as a worktree (left by a failed removal). */
function leftovers(lanes: Lane[]): string[] {
  if (!fs.existsSync(config.root)) return [];
  return fs.readdirSync(config.root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    // Lanes are direct children of the root: compare names, the root may be spelled another way.
    .filter((e) => !lanes.some((l) => path.basename(l.path).toLowerCase() === e.name.toLowerCase()))
    .map((e) => path.join(config.root, e.name));
}

function keepReason(s: LocalState, pr: Pr | null): string {
  if (!pr) return 'no PR';
  if (pr.state !== 'MERGED') return `PR #${pr.number} ${pr.state.toLowerCase()}`;
  return s.dirty ? `${s.dirty} uncommitted` : 'unpushed commits';
}

export function cmdClean(opts: { yes: boolean }): void {
  const lanes = findLanes();
  const ready: Lane[] = [];
  for (const l of lanes) {
    const s = localState(l);
    const pr = prOf(l);
    const atPrHead = Boolean(pr?.head) && pr?.head === l.head;
    const ok = s.missing || cleanable({ prState: pr?.state, dirty: s.dirty, unpushed: s.unpushed, atPrHead });
    const why = s.missing ? 'folder missing' : ok ? `PR #${pr?.number} merged` : keepReason(s, pr);
    log(`${ok ? 'remove' : 'keep  '}  ${l.name}  (${why})`);
    if (ok) ready.push(l);
  }
  const empty: string[] = [];
  for (const dir of leftovers(lanes)) {
    const isEmpty = fs.readdirSync(dir).length === 0;
    log(`${isEmpty ? 'remove' : 'keep  '}  ${path.basename(dir)}  (${isEmpty ? 'empty leftover folder' : 'not a lane; left alone'})`);
    if (isEmpty) empty.push(dir);
  }
  const count = ready.length + empty.length;
  if (count === 0) return log('nothing to clean');
  if (!opts.yes) return log(`\n${count} item(s) can go. Run again with --yes to remove them.`);
  for (const l of ready) removeLane(l);
  for (const dir of empty) if (rmLaneFolder(dir)) log(`removed empty folder ${path.basename(dir)}`);
  for (const dir of new Set(ready.map((l) => l.repoDir))) pullMainClone(dir);
}

/** After merged lanes go, bring the main clone up to date, unless it holds work of its own. */
function pullMainClone(dir: string): void {
  const name = path.basename(dir);
  if ((gitTry(dir, 'status', '--porcelain') ?? 'x') !== '') return log(`${name}: main clone has local changes; not pulled`);
  if (gitTry(dir, 'rev-parse', '--abbrev-ref', '@{upstream}') === null) return;
  const before = gitTry(dir, 'rev-parse', 'HEAD');
  if (gitTry(dir, 'pull', '--ff-only', '--quiet') === null) return log(`${name}: main clone could not fast-forward; pull it by hand`);
  if (gitTry(dir, 'rev-parse', 'HEAD') !== before) log(`${name}: main clone pulled to ${gitTry(dir, 'log', '-1', '--format=%h %s')}`);
}

export function cmdRemove(name: string, opts: { force: boolean }): void {
  const lane = findLanes().find((l) => l.name === name);
  if (!lane) throw new Error(`no lane called ${name} (see: lane list --local)`);
  const s = localState(lane);
  if (!opts.force && (s.dirty || s.unpushed))
    throw new Error(`${name} has ${s.dirty} uncommitted change(s), ${s.ahead} unpushed commit(s); use --force to drop them`);
  removeLane(lane);
}

const NOTES = `# Lane notes (written by \`lane new\`, not committed)

This checkout is a lane: one of several git worktrees of this repo that may be worked on
at the same time on this machine. Rules for this lane:

- Before using the Android emulator (adb, flutter run, integration tests): run
  \`lane claim emulator\` (it waits until the emulator is free). Run \`lane release emulator\`
  as soon as you are done with it.
- Run heavy builds (flutter build, gradle, cargo build --release) through
  \`lane with build -- <command>\`: at most two run at once, the machine is short on RAM.
- One PR per lane. Do not bump the version or edit the CHANGELOG here: releases are made
  separately after the lanes are merged.
`;

/** Lane rules for Claude Code in the lane; ignored by git in every worktree of the repo. */
function writeLaneNotes(dest: string): void {
  const file = path.join(dest, 'CLAUDE.local.md');
  if (fs.existsSync(file)) return;
  const common = path.resolve(dest, git(dest, 'rev-parse', '--git-common-dir'));
  const exclude = path.join(common, 'info', 'exclude');
  const cur = fs.existsSync(exclude) ? fs.readFileSync(exclude, 'utf8') : '';
  if (!/^\/?CLAUDE\.local\.md$/m.test(cur)) {
    fs.mkdirSync(path.dirname(exclude), { recursive: true });
    const sep = cur && !cur.endsWith('\n') ? '\n' : '';
    fs.appendFileSync(exclude, `${sep}/CLAUDE.local.md\n`);
  }
  fs.writeFileSync(file, NOTES);
}

/** The lane (or clone) the command runs in: its folder name and top-level path. */
function here(): Holder & { lanePath: string } {
  const top = gitTry(process.cwd(), 'rev-parse', '--show-toplevel');
  if (!top) throw new Error('run this inside a lane (or any git checkout)');
  return { lane: path.basename(top), lanePath: path.resolve(top) };
}

const locks = () => new Locks(config.root);

export function cmdClaim(resource: string, opts: { noWait: boolean }): void {
  const me = here();
  locks().take(resource, me, { wait: !opts.noWait });
  log(`${resource} is yours (${me.lane}). Free it with: lane release ${resource}`);
}

export function cmdRelease(resource: string): void {
  const me = here();
  log(locks().release(resource, me.lane) ? `released ${resource}` : `${resource} was not held`);
}

export function cmdLocks(): void {
  const all = locks().list();
  if (all.length === 0) return log('no locks held');
  printTable(['resource', 'held by', 'since', 'state'], all.map((l) => [
    l.name,
    l.lane ?? '?',
    l.since ? new Date(l.since).toLocaleTimeString() : '?',
    l.stale ? 'stale (will be taken over)' : l.pid ? `running (pid ${l.pid})` : 'claimed',
  ]));
}

export function cmdWith(resource: string, slots: number, argv: readonly string[]): number {
  return locks().withSlot(resource, slots, here(), argv);
}

// ---- verify, sync, brief: working with several lanes of one repository ----

/** The lanes of one repository that are on a branch (a detached checkout is not a task). */
function repoLanes(repo: string): Lane[] {
  return findLanes().filter((l) => l.repo === repo && l.branch);
}

/** Check commands for a checkout: --cmd, else the main clone's `.lanecheck`, else detected. */
function checksFor(mainClone: string, checkout: string, custom?: readonly string[]): string[] {
  const files = fs.readdirSync(checkout);
  let scripts: Record<string, string> | undefined;
  try {
    scripts = (JSON.parse(fs.readFileSync(path.join(checkout, 'package.json'), 'utf8')) as { scripts?: Record<string, string> }).scripts;
  } catch {}
  const listed = custom?.length ? custom : readListFile(mainClone, '.lanecheck');
  return checkCommands({ files, scripts, custom: listed });
}

/** Runs each check in a checkout, each holding a build slot; stops at the first failure. */
function runChecks(checkout: string, cmds: readonly string[], holder: Holder): { ok: boolean; failed?: string } {
  for (const c of cmds) {
    log(`> ${c}   (in ${path.basename(checkout)})`);
    if (locks().withSlot('build', 2, holder, [c], { cwd: checkout }) !== 0) return { ok: false, failed: c };
  }
  return { ok: true };
}

/** Git with the repository's hooks off: lane's own merges and rebases are not commits for review. */
const NO_HOOKS = ['-c', 'core.hooksPath=.lane-no-hooks', '-c', 'user.name=lane', '-c', 'user.email=lane@localhost'];

function conflictedFiles(checkout: string): string[] {
  return (gitTry(checkout, 'diff', '--name-only', '--diff-filter=U') ?? '').split(/\r?\n/).filter(Boolean);
}

export interface CheckOptions {
  cmds?: string[];
  keep: boolean;
}

/**
 * Merges every open lane of a repository together on top of its base branch, in a throwaway
 * checkout, and runs the checks there. Lanes can merge cleanly as text and still break each
 * other; this finds that before the first one is merged.
 */
export function cmdVerify(repo: string, opts: CheckOptions): number {
  const dir = repoDir(repo);
  const lanes = repoLanes(repo);
  if (lanes.length === 0) {
    log(`${repo} has no lanes`);
    return 0;
  }
  log(`fetching ${repo}...`);
  git(dir, 'fetch', 'origin', '--prune', '--quiet');
  const base = baseBranch(dir);
  const dest = lanePath(config.root, repo, 'verify');
  freeDest(dest);
  git(dir, 'worktree', 'add', '--detach', dest, `origin/${base}`);
  let ok = false;
  try {
    const rows: string[][] = [];
    const merged: string[] = [];
    for (const l of lanes) {
      if (gitTry(dest, ...NO_HOOKS, 'merge', '--no-ff', '--no-edit', l.branch) !== null) {
        merged.push(l.branch);
        rows.push([l.name, l.branch, 'merged']);
        continue;
      }
      const files = conflictedFiles(dest);
      gitTry(dest, 'merge', '--abort');
      rows.push([l.name, l.branch, `CONFLICT with ${merged.join(', ') || origin(base)}: ${files.join(', ') || '?'}`]);
    }
    printTable(['lane', 'branch', `on origin/${base}`], rows);
    const conflicts = rows.length - merged.length;
    if (merged.length === 0) {
      log('\nnothing merged, nothing to check');
      return 1;
    }
    prepare(dir, dest, { install: true });
    const cmds = checksFor(dir, dest, opts.cmds);
    if (cmds.length === 0) log('\nno checks found: add a .lanecheck file to the main clone, or pass --cmd');
    const result = runChecks(dest, cmds, { lane: path.basename(dest), lanePath: dest });
    ok = result.ok && conflicts === 0;
    log(
      result.ok
        ? `\n${merged.length} lane(s) together on origin/${base}: checks pass${conflicts ? `; ${conflicts} lane(s) conflict` : ''}`
        : `\n${merged.length} lane(s) together on origin/${base}: "${result.failed}" FAILS. Each lane may pass on its own: they break each other.`,
    );
    return ok ? 0 : 1;
  } finally {
    if (opts.keep || !ok) {
      if (opts.keep || fs.existsSync(dest)) log(`the combined checkout stays at ${dest} (remove it with: lane rm ${path.basename(dest)})`);
    } else {
      gitTry(dir, 'worktree', 'remove', '--force', dest);
      if (fs.existsSync(dest)) rmLaneFolder(dest);
      gitTry(dir, 'worktree', 'prune');
    }
  }
}

const origin = (base: string) => `origin/${base}`;

export interface SyncOptions {
  cmds?: string[];
  push: boolean;
}

/**
 * After a lane merges, moves every other open lane of the repository onto the new base branch
 * and runs its checks again: a lane that passed before can fail on top of what just merged.
 */
export function cmdSync(repo: string, opts: SyncOptions): number {
  const dir = repoDir(repo);
  const lanes = repoLanes(repo);
  if (lanes.length === 0) {
    log(`${repo} has no lanes`);
    return 0;
  }
  log(`fetching ${repo}...`);
  git(dir, 'fetch', 'origin', '--prune', '--quiet');
  const base = baseBranch(dir);
  const rows: string[][] = [];
  let bad = 0;
  for (const l of lanes) {
    const s = localState(l);
    if (s.dirty) {
      rows.push([l.name, `skipped: ${s.dirty} uncommitted change(s)`]);
      continue;
    }
    const pr = prOf(l);
    if (pr?.state === 'MERGED') {
      rows.push([l.name, `skipped: PR #${pr.number} merged (lane clean removes it)`]);
      continue;
    }
    if (gitTry(l.path, 'merge-base', '--is-ancestor', origin(base), 'HEAD') !== null) {
      rows.push([l.name, `already on ${origin(base)}`]);
      continue;
    }
    const before = git(l.path, 'rev-parse', 'HEAD');
    if (gitTry(l.path, ...NO_HOOKS, 'rebase', origin(base)) === null) {
      const files = conflictedFiles(l.path);
      gitTry(l.path, 'rebase', '--abort');
      rows.push([l.name, `CONFLICT, left as it was: ${files.join(', ') || '?'} (rebase by hand)`]);
      bad++;
      continue;
    }
    const changed = (gitTry(l.path, 'diff', '--name-only', before, 'HEAD') ?? '').split(/\r?\n/);
    if (changed.some((f) => LOCKFILES.includes(path.basename(f)))) install(l.path);
    const result = runChecks(l.path, checksFor(dir, l.path, opts.cmds), { lane: l.name, lanePath: l.path });
    if (!result.ok) {
      rows.push([l.name, `rebased; "${result.failed}" FAILS on top of ${origin(base)}`]);
      bad++;
      continue;
    }
    let note = 'rebased, checks pass';
    if (opts.push && gitTry(l.path, 'rev-parse', '-q', '--verify', `refs/remotes/origin/${l.branch}`) !== null) {
      note += gitTry(l.path, 'push', '--force-with-lease', 'origin', l.branch) !== null ? ', pushed' : ', PUSH FAILED';
    } else if (gitTry(l.path, 'rev-parse', '-q', '--verify', `refs/remotes/origin/${l.branch}`) !== null) {
      note += '; push with --force-with-lease (or lane sync --push)';
    }
    rows.push([l.name, note]);
  }
  printTable(['lane', `onto ${origin(base)}`], rows);
  return bad ? 1 : 0;
}

/** Prints what an agent working in a lane must know (the lane named, or the one this runs in). */
export function cmdBrief(name?: string): void {
  const lanes = findLanes();
  const cwd = process.cwd();
  const lane = name
    ? lanes.find((l) => l.name === name)
    : lanes.find((l) => samePath(l.path, cwd) || isInside(cwd, l.path));
  if (!lane) throw new Error(name ? `no lane called ${name} (see: lane list --local)` : 'not inside a lane; name one');
  const others = lanes.filter((l) => l.repo === lane.repo && l.name !== lane.name).map((l) => l.path);
  process.stdout.write(
    briefText({
      lane: lane.name,
      path: lane.path,
      branch: lane.branch || '(detached)',
      repo: lane.repo,
      mainClone: lane.repoDir,
      others,
      checks: checksFor(lane.repoDir, lane.path),
    }),
  );
}
