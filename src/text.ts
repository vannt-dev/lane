// What lane prints and writes: tables, the lane notes, an agent's brief, hook wrappers.

export const log = (msg: string) => console.log(msg);

/** Lines of a small list file (`.lanecopy`, `.lanecheck`): trimmed, no blanks, no `#` comments. */
export function listLines(text: string): string[] {
  return text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
}

export function printTable(head: readonly string[], rows: readonly (readonly string[])[]): void {
  const all = [head, ...rows];
  const w = head.map((_, i) => Math.max(...all.map((r) => (r[i] ?? '').length)));
  for (const r of all) log(r.map((c, i) => c.padEnd(w[i] ?? 0)).join('  ').trimEnd());
}

const unix = (p: string) => p.replace(/\\/g, '/');

/** Lanes run servers side by side: each slot shifts the usual port by its number. */
function portRule(slot: number): string {
  return (
    `- This lane is slot ${slot}. A dev server you start listens on \`lane port <its usual port>\` ` +
    `(the usual port + ${slot}), never the usual port itself, so lanes do not take each other's port.`
  );
}

const SHARED_RULES = [
  '- Heavy commands (whole test suites, flutter/gradle/cargo builds) go through `lane with build -- <command>`: at most two run at once.',
  '- The Android emulator: `lane claim emulator` before using it, `lane release emulator` right after.',
  '- One pull request for this lane. Do not bump the version or edit the CHANGELOG: releases are made after the lanes merge.',
];
const GIVE_BACK = '- When the work is pushed or merged, `lane done` gives this slot back (its folder and caches stay for the next task).';

export const NOTES_HEADER = '# Lane notes (written by `lane new`, not committed)';

/** CLAUDE.local.md of a lane: what Claude Code started inside it must know. */
export function laneNotes(slot: number | null): string {
  const intro = 'This checkout is a lane: one of several git worktrees of this repo worked on at the same time.';
  const rules = [...SHARED_RULES, ...(slot ? [portRule(slot)] : []), GIVE_BACK, "- Never use, clean or reset another lane's folder."];
  return `${NOTES_HEADER}\n\n${intro}\n\n${rules.join('\n')}\n`;
}

/** What an agent working in a lane must know, to paste at the top of its task. */
export function briefText(input: {
  lane: string;
  path: string;
  branch: string;
  repo: string;
  mainClone: string;
  others: readonly string[];
  checks: readonly string[];
  slot: number | null;
}): string {
  const p = unix(input.path);
  const away = input.others.length ? ` or in the other lanes: ${input.others.map((o) => `\`${unix(o)}\``).join(', ')}.` : '.';
  const lines = [
    `## Where you work (lane ${input.lane})`,
    `- Your checkout: \`${p}\`, branch \`${input.branch}\` of ${input.repo}. Other tasks run in other lanes at the same time.`,
    `- Start every shell command with \`cd ${p} && \`; give every file tool an absolute path under \`${p}\`.`,
    `- Never read, edit or run anything in the main clone \`${unix(input.mainClone)}\`${away}`,
    ...SHARED_RULES,
    ...(input.slot ? [portRule(input.slot)] : []),
    ...(input.checks.length ? [`- Checks to pass before you push: ${input.checks.map((c) => `\`${c}\``).join(', ')}.`] : []),
    GIVE_BACK,
  ];
  return `${lines.join('\n')}\n`;
}

/**
 * A lane's stand-in for one of the repository's hooks: it runs the original, through
 * `lane with build` when the hook is heavy, so a push does not add a third test run.
 */
export function hookWrapper(name: string, original: string, heavy: boolean): string {
  const target = unix(original);
  const run = heavy ? `exec lane with build -- sh "${target}" "$@"` : `exec "${target}" "$@"`;
  return `#!/bin/sh\n# Written by lane: runs the repository's ${name} hook.\n${run}\n`;
}
