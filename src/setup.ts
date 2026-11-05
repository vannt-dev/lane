// What a new or reused slot needs before work starts in it.
import fs from 'node:fs';
import path from 'node:path';
import { COPY_DEFAULT } from './config.ts';
import { HEAVY_HOOKS, HOOK_NAMES, installCommands, installStamp, LOCKFILES } from './detect.ts';
import type { Lane } from './lane.ts';
import { runLive } from './proc.ts';
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

  private submodules(): void {
    if (!fs.existsSync(path.join(this.lane.dir, '.gitmodules'))) return;
    log('updating submodules...');
    if (!runLive('git submodule update --init --recursive', this.lane.dir))
      log('WARNING: submodules did not load (a private one needs access); the build may fail');
  }

  /** Untracked files of the main clone the work needs (`.env` and the like), when missing. */
  private copyLocalFiles(): void {
    const clone = this.lane.clone;
    for (const file of [...COPY_DEFAULT, ...listLines(clone.readFile('.lanecopy') ?? '')]) {
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
    for (const c of cmds) {
      log(`> ${c}`);
      if (!runLive(c, this.lane.dir)) throw new Error(`"${c}" failed in ${this.lane.dir}; the lane is kept, fix and rerun it there`);
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
    fs.writeFileSync(file, laneNotes(this.lane.slot));
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
