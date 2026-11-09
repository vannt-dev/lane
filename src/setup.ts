// What a new or reused slot needs before work starts in it.
import fs from 'node:fs';
import path from 'node:path';
import { config, COPY_DEFAULT } from './config.ts';
import { HEAVY_HOOKS, HOOK_NAMES, installCommands, installStamp, LOCKFILES } from './detect.ts';
import type { Lane } from './lane.ts';
import { runLive } from './proc.ts';
import { currentDirs, inCone } from './sparse.ts';
import { hookWrapper, laneNotes, listLines, log, NOTES_HEADER } from './text.ts';

export class LaneSetup {
  readonly lane: Lane;

  constructor(lane: Lane) {
    this.lane = lane;
  }

  /** Submodules, untracked local files, dependencies, the lane notes and the hook wrappers. */
  run(opts: { install: boolean }): void {
    this.submodules();
    this.copyLocalFiles();
    if (opts.install) this.install();
    this.writeNotes();
    this.wrapHeavyHooks();
  }

  /** The submodules; a sparse lane loads only those inside its folders (git would load all). */
  private submodules(): void {
    if (!fs.existsSync(path.join(this.lane.dir, '.gitmodules'))) return;
    const dirs = currentDirs(this.lane);
    let only = '';
    if (dirs.length > 0) {
      const listed = this.lane.tryGit('config', '-f', '.gitmodules', '--get-regexp', '\\.path$') ?? '';
      const paths = listed.split(/\r?\n/).filter(Boolean).map((l) => l.replace(/^\S+\s+/, ''));
      const inside = paths.filter((p) => inCone(`${p}/-`, dirs));
      if (inside.length === 0) return log('submodules: none inside the sparse folders, none loaded');
      only = ` -- ${inside.map((p) => `"${p}"`).join(' ')}`;
    }
    log('updating submodules...');
    if (!runLive(`git submodule update --init --recursive${only}`, this.lane.dir))
      log('WARNING: submodules did not load (a private one needs access); the build may fail');
  }

  /**
   * Untracked files of the main clone the work needs (`.env` and the like), when missing. A
   * sparse lane skips those in a folder of the repository it does not check out
   * (`android/key.properties` without `android`); an untracked folder like `.claude` is copied.
   */
  private copyLocalFiles(): void {
    const clone = this.lane.clone;
    const dirs = currentDirs(this.lane);
    const leftOut = (file: string) =>
      !inCone(file, dirs) && this.lane.tryGit('cat-file', '-e', `HEAD:${path.posix.dirname(file.replace(/\\/g, '/'))}`) !== null;
    for (const file of [...COPY_DEFAULT, ...listLines(clone.readFile('.lanecopy') ?? '')]) {
      if (leftOut(file)) continue;
      const from = path.join(clone.dir, file);
      const to = path.join(this.lane.dir, file);
      if (fs.existsSync(to) || !fs.existsSync(from) || !fs.statSync(from).isFile()) continue;
      if (clone.tryGit('ls-files', '--error-unmatch', '--', file) !== null) continue;
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(from, to);
      log(`copied ${file}`);
    }
  }

  private stamp(): string {
    const present = LOCKFILES.filter((f) => fs.existsSync(path.join(this.lane.dir, f)));
    return installStamp(present.map((name) => ({ name, text: fs.readFileSync(path.join(this.lane.dir, name), 'utf8') })));
  }

  /** Installs dependencies, unless this slot already installed them from the same lockfiles. */
  install(): void {
    const cmds = installCommands(fs.readdirSync(this.lane.dir));
    if (cmds.length === 0) return;
    const stamp = this.stamp();
    if (this.lane.meta().installStamp === stamp) return log('dependencies: lockfiles unchanged since this slot installed them');
    const sparse = currentDirs(this.lane).length > 0;
    for (const c of cmds) {
      log(`> ${c}`);
      if (runLive(c, this.lane.dir)) continue;
      // A workspace outside the folders makes a monorepo's install fail; the lane still works.
      if (sparse) {
        return log(`WARNING: "${c}" failed in this sparse lane, often a workspace outside its folders. ` +
          'The lane is ready without dependencies: git sparse-checkout add <folder> and rerun it, or take the lane with --no-sparse');
      }
      throw new Error(`"${c}" failed in ${this.lane.dir}; the lane is kept, fix and rerun it there`);
    }
    this.lane.setMeta({ installStamp: stamp });
  }

  /** CLAUDE.local.md with the lane rules, ignored by git in every worktree of the repository. */
  private writeNotes(): void {
    const file = path.join(this.lane.dir, 'CLAUDE.local.md');
    // a CLAUDE.local.md someone wrote is theirs; lane rewrites only its own
    if (fs.existsSync(file) && !fs.readFileSync(file, 'utf8').startsWith(NOTES_HEADER)) return;
    const exclude = path.join(path.resolve(this.lane.dir, this.lane.git('rev-parse', '--git-common-dir')), 'info', 'exclude');
    const cur = fs.existsSync(exclude) ? fs.readFileSync(exclude, 'utf8') : '';
    if (!/^\/?CLAUDE\.local\.md$/m.test(cur)) {
      fs.mkdirSync(path.dirname(exclude), { recursive: true });
      fs.appendFileSync(exclude, `${cur && !cur.endsWith('\n') ? '\n' : ''}/CLAUDE.local.md\n`);
    }
    const notes = { slot: this.lane.slot, lease: this.lane.lease(), stride: config.portStride, sparse: currentDirs(this.lane) };
    fs.writeFileSync(file, laneNotes(notes));
  }

  /**
   * Gives the lane its own hooks folder, where a heavy hook (pre-push runs the whole test suite)
   * waits for a build slot and every other hook runs as before. Only this worktree uses it.
   */
  private wrapHeavyHooks(): void {
    const lane = this.lane;
    if (lane.tryGit('config', '--worktree', 'core.hooksPath') !== null) return;
    const original = path.resolve(lane.dir, lane.git('rev-parse', '--git-path', 'hooks'));
    if (!fs.existsSync(original)) return;
    const hooks = fs.readdirSync(original).filter((h) => HOOK_NAMES.includes(h) && fs.statSync(path.join(original, h)).isFile());
    const heavy = hooks.filter((h) => HEAVY_HOOKS.includes(h));
    if (heavy.length === 0) return;
    const own = path.join(lane.gitDir(), 'lane-hooks');
    fs.mkdirSync(own, { recursive: true });
    for (const h of hooks) fs.writeFileSync(path.join(own, h), hookWrapper(h, path.join(original, h), heavy.includes(h)), { mode: 0o755 });
    lane.clone.git('config', 'extensions.worktreeConfig', 'true');
    lane.git('config', '--worktree', 'core.hooksPath', own);
    log(`hooks: ${heavy.join(', ')} wait for a build slot in this lane`);
  }
}
