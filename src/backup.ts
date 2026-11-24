// Before lane throws a slot's work away (lane rm --force, lane clean): a commit holding it,
// kept under refs/lane-backup/<lane>/<time> in the main clone, the newest few per lane.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MainClone } from './checkout.ts';
import { config } from './config.ts';
import type { Lane } from './lane.ts';
import { run } from './proc.ts';
import { log, printTable } from './text.ts';

const PREFIX = 'refs/lane-backup';
/** The backups are lane's own commits, made without the repository's identity. */
const IDENT = ['-c', 'user.name=lane', '-c', 'user.email=lane@localhost'];

/** A lane name as one part of a ref: anything git would refuse becomes `_`. */
const refPart = (name: string) => name.replace(/[^\w.-]/g, '_').replace(/^\.+|\.lock$/g, '_');

/** Commits of `head` that no other branch, tag or remote branch has: they go with the branch. */
function lostCommits(clone: MainClone, head: string, branch: string): number {
  const others = ['--remotes', '--tags', ...(branch ? [`--exclude=${branch}`] : []), '--branches'];
  return Number(clone.tryGit('rev-list', '--count', head, '--not', ...others) ?? '0');
}

/**
 * The slot's files as a tree: tracked changes and untracked files, not ignored ones. Staged in
 * a copy of the slot's index (it keeps a sparse slot's folders out), never in the index itself.
 */
function snapshotTree(lane: Lane, head: string): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lane-backup-'));
  const env = { GIT_INDEX_FILE: path.join(tmp, 'index') };
  try {
    const index = path.join(lane.gitDir(), 'index');
    if (fs.existsSync(index)) fs.copyFileSync(index, env.GIT_INDEX_FILE);
    else run('git', ['read-tree', head], lane.dir, undefined, env);
    run('git', ['add', '-A'], lane.dir, undefined, env);
    return run('git', ['write-tree'], lane.dir, undefined, env);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** A ref no backup has yet: the time to the millisecond, a number after it in the rare tie. */
function freshRef(clone: MainClone, lane: string): string {
  const base = `${PREFIX}/${refPart(lane)}/${new Date().toISOString().replace(/[:.]/g, '-')}`;
  let ref = base;
  for (let n = 2; clone.hasRef(ref); n++) ref = `${base}-${n}`;
  return ref;
}

/** Drops all but the newest `keep` backups of a lane (the names sort by time). */
function prune(clone: MainClone, lane: string, keep: number): void {
  const refs = (clone.tryGit('for-each-ref', '--sort=-refname', '--format=%(refname)', `${PREFIX}/${refPart(lane)}/`) ?? '')
    .split(/\r?\n/).filter(Boolean);
  for (const ref of refs.slice(keep)) clone.tryGit('update-ref', '-d', ref);
}

/**
 * Saves what removing the lane would lose: uncommitted and untracked files (a commit on top of
 * HEAD), and commits only its branch has (HEAD is that commit's parent). Returns the line that
 * says where it is and how to get it back; null when nothing would be lost or backups are off.
 */
export function backupWork(lane: Lane, why: string): string | null {
  const keep = config.keepBackups;
  if (keep === 0) return null;
  const clone = lane.clone;
  const head = (lane.exists ? lane.tryGit('rev-parse', '-q', '--verify', 'HEAD') : null) ?? lane.wt.head;
  if (!head || !clone.hasRef(`${head}^{commit}`)) return null;
  const changed = lane.exists ? lane.dirty() : 0;
  const lost = lostCommits(clone, head, lane.branch);
  if (changed === 0 && lost === 0) return null;
  const tree = changed > 0 ? snapshotTree(lane, head) : clone.git('rev-parse', `${head}^{tree}`);
  const what = `${changed} uncommitted, ${lost} unpushed commit(s)`;
  const subject = `lane backup of ${lane.name} (${lane.branch || 'detached'}) before ${why}`;
  const commit = clone.git(...IDENT, 'commit-tree', tree, '-p', head, '-m', subject, '-m', `${what}; HEAD was ${head}`);
  const ref = freshRef(clone, lane.name);
  clone.git('update-ref', ref, commit);
  prune(clone, lane.name, keep);
  const files = changed > 0 ? `; the files: git checkout ${ref} -- .` : '';
  const commits = lost > 0 ? `; the branch: git branch ${lane.branch || '<name>'} ${ref}~1` : '';
  return `backup of ${lane.name}: ${ref} (${what})${files}${commits}`;
}

/** Every backup lane kept, newest first, with how to restore one and drop it. */
export function cmdBackups(repo?: string): void {
  const clones = repo ? [new MainClone(repo)] : MainClone.all();
  const format = '%(refname)%09%(committerdate:format:%Y-%m-%d %H:%M)%09%(subject)';
  const rows = clones.flatMap((c) => (c.tryGit('for-each-ref', '--sort=-committerdate', `--format=${format}`, `${PREFIX}/`) ?? '')
    .split(/\r?\n/).filter(Boolean).map((line) => [c.name, ...line.split('\t')]));
  if (rows.length === 0) return log('no backups');
  printTable(['repo', 'ref', 'made', 'what'], rows);
  log('\nIn any checkout of that repository:');
  log('  the files:       git checkout <ref> -- .');
  log('  the branch:      git branch <name> <ref>~1');
  log(`  drop a backup:   git update-ref -d <ref>   (lane keeps the newest ${config.keepBackups} per lane: LANE_KEEP_BACKUPS)`);
}
