import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { errCode, git, gitTry, runLive, sleepMs, tryRun } from './sh.ts';
import { Locks, type Holder } from './locks.ts';
import {
  checksState, cleanable, installCommands, isInside, lanePath, parseWorktrees, pickBase, repoSlug,
  samePath, type ChecksState, type Check, type Worktree,
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

function copyList(dir: string): string[] {
  const extra = path.join(dir, '.lanecopy');
  const more = fs.existsSync(extra)
    ? fs.readFileSync(extra, 'utf8').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
    : [];
  return [...COPY_DEFAULT, ...more];
}

function isTracked(dir: string, file: string): boolean {
  return gitTry(dir, 'ls-files', '--error-unmatch', '--', file) !== null;
}

export interface NewOptions {
  base?: string;
  branch?: string;
  install: boolean;
  open: boolean;
}

export function cmdNew(repo: string, task: string, opts: NewOptions): void {
  const dir = repoDir(repo);
  const branch = opts.branch || task;
  const dest = lanePath(config.root, repo, task);
  if (fs.existsSync(dest)) {
    if (fs.readdirSync(dest).length > 0) throw new Error(`${dest} already exists`);
    fs.rmdirSync(dest);
  }
  if (gitTry(dir, 'rev-parse', '-q', '--verify', `refs/heads/${branch}`) !== null)
    throw new Error(`branch ${branch} already exists in ${repo}; pick another task name or --branch`);

  log(`fetching ${repo}...`);
  git(dir, 'fetch', 'origin', '--prune', '--quiet');
  const base = opts.base || baseBranch(dir);
  if (gitTry(dir, 'rev-parse', '-q', '--verify', `refs/remotes/origin/${branch}`) !== null)
    log(`note: origin/${branch} already exists; the lane starts from ${base}, not from it`);

  fs.mkdirSync(config.root, { recursive: true });
  // --no-track: the new branch must not push into the base branch by accident.
  git(dir, 'worktree', 'add', '--no-track', '-b', branch, dest, `origin/${base}`);
  log(`lane ${path.basename(dest)}: branch ${branch} from origin/${base}`);

  if (fs.existsSync(path.join(dest, '.gitmodules'))) {
    log('fetching submodules...');
    if (!runLive('git submodule update --init --recursive', dest))
      log('WARNING: submodules did not load (private core needs access); the build may fail');
  }

  for (const file of copyList(dir)) {
    const from = path.join(dir, file);
    if (!fs.existsSync(from) || !fs.statSync(from).isFile() || isTracked(dir, file)) continue;
    fs.mkdirSync(path.dirname(path.join(dest, file)), { recursive: true });
    fs.copyFileSync(from, path.join(dest, file));
    log(`copied ${file}`);
  }

  writeLaneNotes(dest);

  if (opts.install) {
    for (const c of installCommands(fs.readdirSync(dest))) {
      log(`> ${c}`);
      if (!runLive(c, dest)) throw new Error(`"${c}" failed in ${dest}; the lane is kept, fix and rerun it there`);
    }
  }

  if (opts.open) openClaude(dest);
  else log(`\nnext: cd ${dest} && claude      (or: lane new ... --open)`);
}

function openClaude(dir: string): void {
  // A new Windows Terminal tab running Claude Code in the lane.
  const child = spawn('wt.exe', ['-w', '0', 'nt', '-d', dir, 'claude'], { detached: true, stdio: 'ignore' });
  child.on('error', () => log(`could not open Windows Terminal; run: cd ${dir} && claude`));
  child.unref();
  log(`opened Claude Code in ${dir}`);
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
      if (!isInside(w.path, config.root)) continue;
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
  if (!isInside(lane.path, config.root)) throw new Error(`${lane.path} is not under ${config.root}`);
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
    .map((e) => path.join(config.root, e.name))
    .filter((dir) => !lanes.some((l) => samePath(l.path, dir)));
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
