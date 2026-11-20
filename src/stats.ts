// What `lane with` runs cost in waiting and running, for `lane stats`: one JSON line per run in
// <lane root>/.locks/stats.log. Only a short label of the command is kept, never its arguments
// (they can hold tokens).
import fs from 'node:fs';
import path from 'node:path';

export interface Run {
  at: number;
  res: string;
  label: string;
  cost: number;
  waitMs: number;
  runMs: number;
  status: number;
}

export interface StatRow {
  res: string;
  label: string;
  runs: number;
  failed: number;
  avgWaitMs: number;
  maxWaitMs: number;
  avgRunMs: number;
}

const DAY = 86_400_000;
const statsFile = (root: string) => path.join(root, '.locks', 'stats.log');

/** Tools whose next word says what runs (`npm run test`, `cargo build`). */
const RUNNERS = new Set(['npx', 'npm', 'pnpm', 'yarn', 'bun', 'bunx', 'uv', 'uvx', 'python', 'python3', 'py', 'node',
  'dotnet', 'flutter', 'dart', 'cargo', 'go', 'deno', 'gradle', 'mvn']);
const PLAIN = /^[\w:.@-]+$/;

/** A short name for a command: the tool, and its subcommand when the tool runs others. */
export function commandLabel(argv: readonly string[]): string {
  const words = argv.length === 1 ? (argv[0] ?? '').trim().split(/\s+/) : [...argv];
  const tool = path.basename((words[0] ?? '?').replace(/\\/g, '/')).replace(/\.(cmd|bat|exe|ps1)$/i, '');
  const label = [tool];
  const next = (i: number) => (words[i] !== undefined && !words[i]!.startsWith('-') && PLAIN.test(words[i]!) ? words[i] : undefined);
  if (RUNNERS.has(tool.toLowerCase()) && next(1)) {
    label.push(next(1)!);
    if (['run', 'exec', 'x', 'dlx'].includes(next(1)!) && next(2)) label.push(next(2)!);
  }
  return label.join(' ');
}

/** Adds a run; drops runs older than 30 days once the file grows past 1 MB. Never throws. */
export function logRun(root: string, run: Run): void {
  try {
    const file = statsFile(root);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(run)}\n`);
    if (fs.statSync(file).size > 1024 * 1024) {
      const keep = readStats(root).filter((r) => r.at > Date.now() - 30 * DAY);
      fs.writeFileSync(file, keep.map((r) => `${JSON.stringify(r)}\n`).join(''));
    }
  } catch {
    // stats are a help, never a reason for the command to fail
  }
}

export function readStats(root: string): Run[] {
  let text: string;
  try {
    text = fs.readFileSync(statsFile(root), 'utf8');
  } catch {
    return [];
  }
  return text.split('\n').flatMap((line) => {
    try {
      return line ? [JSON.parse(line) as Run] : [];
    } catch {
      return [];
    }
  });
}

/** Per resource and label within the last `days`: most total waiting first. */
export function summarize(runs: readonly Run[], { days, now = Date.now() }: { days: number; now?: number }): StatRow[] {
  const groups = new Map<string, Run[]>();
  for (const r of runs) {
    if (r.at < now - days * DAY) continue;
    const key = `${r.res}\0${r.label}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  const sum = (rs: Run[], f: (r: Run) => number) => rs.reduce((s, r) => s + f(r), 0);
  return [...groups.values()]
    .map((rs) => ({ rs, wait: sum(rs, (r) => r.waitMs) }))
    .sort((a, b) => b.wait - a.wait)
    .map(({ rs, wait }) => ({
      res: rs[0]!.res,
      label: rs[0]!.label,
      runs: rs.length,
      failed: rs.filter((r) => r.status !== 0).length,
      avgWaitMs: Math.round(wait / rs.length),
      maxWaitMs: Math.max(...rs.map((r) => r.waitMs)),
      avgRunMs: Math.round(sum(rs, (r) => r.runMs) / rs.length),
    }));
}
