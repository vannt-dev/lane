import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { git, gitTry, run, runLive } from './sh.mjs';
import { Locks } from './locks.mjs';
import {
  lanePath, pickBase, installCommands, parseWorktrees, samePath, isInside,
  checksState, cleanable, repoSlug,
} from './core.mjs';

export const config = {
  root: process.env.LANE_ROOT || 'F:/wt',
  repos: process.env.LANE_REPOS || 'F:/ai-agent',
};

const log = (...a) => console.log(...a);

// Untracked files worth carrying over from the main clone. A repo can add more,
// one path per line, in an untracked `.lanecopy` file at its root.
const COPY_DEFAULT = ['.env', '.env.local', 'android/key.properties', '.claude/settings.local.json'];

function repoDir(repo) {
  const dir = path.join(config.repos, repo);
  if (!fs.existsSync(path.join(dir, '.git'))) throw new Error(`no git clone at ${dir}`);
  return dir;
}

function baseBranch(dir) {
  const hasDevelop = gitTry(dir, 'rev-parse', '-q', '--verify', 'refs/remotes/origin/develop') !== null;
  if (!hasDevelop) gitTry(dir, 'remote', 'set-head', 'origin', '-a');
  const originHead = gitTry(dir, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD') || '';
  return pickBase({ hasDevelop, originHead });
}

function copyList(dir) {
  const extra = path.join(dir, '.lanecopy');
  const more = fs.existsSync(extra)
    ? fs.readFileSync(extra, 'utf8').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
    : [];
  return [...COPY_DEFAULT, ...more];
}

function isTracked(dir, file) {
  return gitTry(dir, 'ls-files', '--error-unmatch', '--', file) !== null;
}

export function cmdNew(repo, task, opts) {
  const dir = repoDir(repo);
  const branch = opts.branch || task;
  const dest = lanePath(config.root, repo, task);
  if (fs.existsSync(dest)) throw new Error(`${dest} already exists`);
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

  writeLaneNotes(dir, dest);

  if (opts.install) {
    const cmds = installCommands(fs.readdirSync(dest));
    for (const c of cmds) {
      log(`> ${c}`);
      if (!runLive(c, dest)) throw new Error(`"${c}" failed in ${dest}; the lane is kept, fix and rerun it there`);
    }
  }

  if (opts.open) openClaude(dest);
  else log(`\nnext: cd ${dest} && claude      (or: lane new ... --open)`);
}

function openClaude(dir) {
  // A new Windows Terminal tab running Claude Code in the lane.
  const child = spawn('wt.exe', ['-w', '0', 'nt', '-d', dir, 'claude'], { detached: true, stdio: 'ignore' });
  child.on('error', () => log(`could not open Windows Terminal; run: cd ${dir} && claude`));
  child.unref();
  log(`opened Claude Code in ${dir}`);
}

/** Every lane under the lane root, across all clones in the repos folder. */
export function findLanes() {
  const lanes = [];
  for (const name of fs.readdirSync(config.repos)) {
    const dir = path.join(config.repos, name);
    if (!fs.existsSync(path.join(dir, '.git')) || !fs.statSync(path.join(dir, '.git')).isDirectory()) continue;
    const out = gitTry(dir, 'worktree', 'list', '--porcelain');
    if (!out) continue;
    for (const w of parseWorktrees(out)) {
      if (!isInside(w.path, config.root)) continue;
      lanes.push({ repo: name, repoDir: dir, ...w, name: path.basename(w.path) });
    }
  }
  return lanes;
}

function localState(lane) {
  if (!fs.existsSync(lane.path)) return { dirty: 0, unpushed: false, missing: true };
  const status = gitTry(lane.path, 'status', '--porcelain') ?? '';
  const dirty = status ? status.split(/\r?\n/).length : 0;
  // Commits that are on no remote branch at all.
  const ahead = gitTry(lane.path, 'rev-list', '--count', 'HEAD', '--not', '--remotes=origin') ?? '0';
  return { dirty, unpushed: Number(ahead) > 0, ahead: Number(ahead), missing: false };
}

function prOf(lane) {
  const url = gitTry(lane.repoDir, 'remote', 'get-url', 'origin');
  const slug = url && repoSlug(url);
  if (!slug || !lane.branch) return null;
  const out = run('gh', ['pr', 'list', '-R', slug, '--head', lane.branch, '--state', 'all', '--limit', '1',
    '--json', 'number,state,statusCheckRollup'], { allowFail: true });
  if (!out) return null;
  const [pr] = JSON.parse(out);
  return pr ? { number: pr.number, state: pr.state, checks: checksState(pr.statusCheckRollup) } : null;
}

export function cmdList(opts) {
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

function printTable(head, rows) {
  const all = [head, ...rows];
  const w = head.map((_, i) => Math.max(...all.map((r) => String(r[i]).length)));
  for (const r of all) log(r.map((c, i) => String(c).padEnd(w[i])).join('  '));
}

function removeLane(lane) {
  if (samePath(lane.path, lane.repoDir)) throw new Error('refusing to remove a main clone');
  if (!isInside(lane.path, config.root)) throw new Error(`${lane.path} is not under ${config.root}`);
  if (gitTry(lane.repoDir, 'worktree', 'remove', '--force', lane.path) === null && fs.existsSync(lane.path)) {
    // Long paths (node_modules, Gradle) can defeat git; the \\?\ prefix lifts Windows' limit.
    const long = process.platform === 'win32' ? `\\\\?\\${path.resolve(lane.path)}` : lane.path;
    fs.rmSync(long, { recursive: true, force: true });
  }
  gitTry(lane.repoDir, 'worktree', 'prune');
  if (lane.branch) gitTry(lane.repoDir, 'branch', '-D', lane.branch);
  log(`removed ${lane.name}${lane.branch ? ` and local branch ${lane.branch}` : ''}`);
}

export function cmdClean(opts) {
  const lanes = findLanes();
  const ready = [];
  for (const l of lanes) {
    const s = localState(l);
    const pr = prOf(l);
    const ok = s.missing || cleanable({ prState: pr?.state, dirty: s.dirty, unpushed: s.unpushed });
    const why = s.missing ? 'folder missing'
      : ok ? `PR #${pr.number} merged`
      : !pr ? 'no PR' : pr.state !== 'MERGED' ? `PR #${pr.number} ${pr.state.toLowerCase()}`
      : s.dirty ? `${s.dirty} uncommitted` : 'unpushed commits';
    log(`${ok ? 'remove' : 'keep  '}  ${l.name}  (${why})`);
    if (ok) ready.push(l);
  }
  if (ready.length === 0) return log('nothing to clean');
  if (!opts.yes) return log(`\n${ready.length} lane(s) can go. Run again with --yes to remove them.`);
  for (const l of ready) removeLane(l);
}

export function cmdRemove(name, opts) {
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
function writeLaneNotes(dir, dest) {
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
function here() {
  const top = gitTry(process.cwd(), 'rev-parse', '--show-toplevel');
  if (!top) throw new Error('run this inside a lane (or any git checkout)');
  return { lane: path.basename(top), lanePath: path.resolve(top) };
}

const locks = () => new Locks(config.root);

export function cmdClaim(resource, opts) {
  const me = here();
  locks().take(resource, me, { wait: !opts.noWait });
  log(`${resource} is yours (${me.lane}). Free it with: lane release ${resource}`);
}

export function cmdRelease(resource) {
  const me = here();
  log(locks().release(resource, me.lane) ? `released ${resource}` : `${resource} was not held`);
}

export function cmdLocks() {
  const all = locks().list();
  if (all.length === 0) return log('no locks held');
  printTable(['resource', 'held by', 'since', 'state'], all.map((l) => [
    l.name, l.lane ?? '?', l.since ? new Date(l.since).toLocaleTimeString() : '?',
    l.stale ? 'stale (will be taken over)' : l.pid ? `running (pid ${l.pid})` : 'claimed',
  ]));
}

export function cmdWith(resource, slots, argv) {
  return locks().withSlot(resource, slots, here(), argv);
}
