// Holds that look abandoned: an agent killed or closed without giving its slot back.
import path from 'node:path';
import fs from 'node:fs';
import { tryRun } from './proc.ts';
import { parseReason } from './worktrees.ts';

/** A hold this old, on a slot unchanged this long, with no process in it, looks abandoned. */
export const ABANDONED_MS = 4 * 3600_000;

export function looksAbandoned(s: { heldMs: number | null; idleMs: number; processes: number }): boolean {
  return s.heldMs !== null && s.heldMs >= ABANDONED_MS && s.idleMs >= ABANDONED_MS && s.processes === 0;
}

/** looksAbandoned for a slot held with `reason`; the process scan runs only when it matters. */
export function holdAbandoned(dir: string, reason: string | null, idleMs: number): boolean {
  const since = reason === null ? null : parseReason(reason).since;
  const heldMs = since === null ? null : Date.now() - since;
  if (heldMs === null || heldMs < ABANDONED_MS || idleMs < ABANDONED_MS) return false;
  return looksAbandoned({ heldMs, idleMs, processes: processesUsing(dir).length });
}

const norm = (p: string) => p.replace(/\\/g, '/').toLowerCase();

/** Every running process as `pid<TAB>command line`, plus `<TAB>cwd` where the system tells it. */
function processTable(): string[] {
  if (process.platform === 'win32') {
    const ps = 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId)`t$($_.ExecutablePath) $($_.CommandLine)" }';
    return (tryRun('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps]) ?? '').split(/\r?\n/);
  }
  if (fs.existsSync('/proc/self/cwd')) {
    return fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d)).map((pid) => {
      const read = (f: string) => {
        try {
          return f === 'cwd' ? fs.readlinkSync(`/proc/${pid}/cwd`) : fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ');
        } catch {
          return '';
        }
      };
      return `${pid}\t${read('cmdline')}\t${read('cwd')}`;
    });
  }
  return (tryRun('ps', ['-axo', 'pid=,command=']) ?? '').split('\n').map((l) => l.trim().replace(/\s+/, '\t'));
}

/**
 * Processes that use a folder: started from it (Linux: their working folder) or naming it on
 * their command line (a dev server, a test run, an editor). Windows does not tell another
 * process's working folder, so there a shell sitting in the slot is not seen.
 */
export function processesUsing(dir: string): number[] {
  // the folder itself or a path inside it, never a longer name (repo-1 is not repo-10)
  const target = new RegExp(`${norm(path.resolve(dir)).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w.-])`);
  return processTable().flatMap((row) => {
    const [pid, ...rest] = row.split('\t');
    const n = Number(pid);
    if (!n || n === process.pid || !rest.some((r) => target.test(norm(r)))) return [];
    return [n];
  });
}
