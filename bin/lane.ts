#!/usr/bin/env node
import { parseArgs } from 'node:util';
import {
  cmdClaim, cmdClean, cmdList, cmdLocks, cmdNew, cmdRelease, cmdRemove, cmdWith, config,
} from '../src/commands.ts';

const HELP = `lane: one git worktree per task, so tasks in one repo run side by side

  lane new <repo> <task> [--base B] [--branch NAME] [--no-install] [--open]
      New worktree ${config.root}/<repo>-<task> on a new branch (default: the task name)
      from origin/develop if it exists, else the default branch. Loads submodules,
      copies untracked .env-type files, installs dependencies, --open starts Claude Code.
  lane list [--local]        Every lane: branch, local changes, PR and CI (--local: no GitHub calls)
  lane clean [--yes]         Lanes whose PR is merged and tree is clean; --yes removes them
  lane rm <lane> [--force]   Remove one lane (--force drops uncommitted/unpushed work)

  lane claim <res> [--no-wait]  Hold a shared thing (e.g. emulator) for this lane; waits if busy
  lane release <res>            Give it back
  lane with <res> [--slots N] -- <command>
                                Run a command holding one of N slots (default: build has 2)
  lane locks                    Who holds what

  <repo> is a folder in ${config.repos}. Env: LANE_ROOT, LANE_REPOS.`;

// Everything after "--" is the command for `lane with`, passed through untouched.
const argv = process.argv.slice(2);
const dash = argv.indexOf('--');
const tail = dash >= 0 ? argv.slice(dash + 1) : [];
const { values, positionals } = parseArgs({
  args: dash >= 0 ? argv.slice(0, dash) : argv,
  allowPositionals: true,
  options: {
    base: { type: 'string' },
    branch: { type: 'string' },
    'no-install': { type: 'boolean', default: false },
    open: { type: 'boolean', default: false },
    local: { type: 'boolean', default: false },
    yes: { type: 'boolean', default: false },
    force: { type: 'boolean', default: false },
    'no-wait': { type: 'boolean', default: false },
    slots: { type: 'string' },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

function main(): number {
  const [cmd, a, b, ...extra] = positionals;
  const one = a !== undefined && b === undefined;
  if (values.help || !cmd) {
    console.log(HELP);
    return 0;
  }
  if (cmd === 'new' && a !== undefined && b !== undefined && extra.length === 0) {
    cmdNew(a, b, { base: values.base, branch: values.branch, install: !values['no-install'], open: values.open });
  } else if (cmd === 'list') cmdList({ local: values.local });
  else if (cmd === 'clean') cmdClean({ yes: values.yes });
  else if (cmd === 'rm' && one) cmdRemove(a, { force: values.force });
  else if (cmd === 'claim' && one) cmdClaim(a, { noWait: values['no-wait'] });
  else if (cmd === 'release' && one) cmdRelease(a);
  else if (cmd === 'locks') cmdLocks();
  else if (cmd === 'with' && one && tail.length > 0) {
    const slots = Number(values.slots ?? (a === 'build' ? 2 : 1));
    if (!Number.isInteger(slots) || slots < 1) throw new Error('--slots must be a whole number >= 1');
    return cmdWith(a, slots, tail);
  } else {
    console.error(HELP);
    return 2;
  }
  return 0;
}

try {
  process.exitCode = main();
} catch (e) {
  console.error(`lane: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
}
