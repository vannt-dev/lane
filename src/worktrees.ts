// Pure helpers about worktrees, slots and their locks. Unit-tested.

export interface Worktree {
  path: string;
  head: string;
  branch: string;
  /** `git worktree lock`: null when not locked, else the reason ('' when none was given). */
  locked: string | null;
}

/** Undoes git's C-style quoting (`"feat \302\267 x"`), used for paths and lock reasons. */
export function unquote(s: string): string {
  if (s.length < 2 || !s.startsWith('"') || !s.endsWith('"')) return s;
  const escapes: Record<string, number> = { n: 10, t: 9, '"': 34, '\\': 92 };
  const bytes: number[] = [];
  const body = s.slice(1, -1);
  for (let i = 0; i < body.length; i++) {
    const c = body.charAt(i);
    if (c !== '\\') bytes.push(...Buffer.from(c));
    else if (/^[0-7]{3}$/.test(body.slice(i + 1, i + 4))) {
      bytes.push(parseInt(body.slice(i + 1, i + 4), 8));
      i += 3;
    } else {
      const e = body.charAt(++i);
      bytes.push(escapes[e] ?? e.charCodeAt(0));
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

/** `git worktree list --porcelain` -> one entry per worktree (bare repositories left out). */
export function parseWorktrees(text: string): Worktree[] {
  const list: Worktree[] = [];
  let cur: Worktree | null = null;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) {
      cur = { path: unquote(line.slice(9)), head: '', branch: '', locked: null };
      list.push(cur);
    } else if (!cur) continue;
    else if (line.startsWith('HEAD ')) cur.head = line.slice(5);
    else if (line.startsWith('branch ')) cur.branch = line.slice(7).replace(/^refs\/heads\//, '');
    else if (line === 'locked') cur.locked = '';
    else if (line.startsWith('locked ')) cur.locked = unquote(line.slice(7));
  }
  return list;
}

/** A slot is a reusable worktree named after its repository and a number: `repokeeper-2`. */
export const slotName = (repo: string, n: number) => `${repo}-${n}`;

/** The slot number of a lane folder of `repo`, or null for a folder with another name. */
export function slotNumber(name: string, repo: string): number | null {
  const m = name.toLowerCase().match(/^(.*)-(\d+)$/);
  return m && m[1] === repo.toLowerCase() ? Number(m[2]) : null;
}

/**
 * The reason `git worktree lock` records: what the slot is held for, since when (UTC), and
 * the hold's lease id.
 */
export function lockReason(task: string, now: Date, lease: string): string {
  return `${task} @ ${now.toISOString().slice(0, 16).replace('T', ' ')}Z #${lease}`;
}

/** Task, start time and lease back out of a lock reason (another tool's reason is all task). */
export function parseReason(reason: string): { task: string; since: number | null; lease: string | null } {
  const m = reason.match(/^(.*) @ (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})Z(?: #([0-9a-f]+))?$/);
  if (!m || !m[1]) return { task: reason, since: null, lease: null };
  return { task: m[1], since: Date.parse(`${m[2]}T${m[3]}:00Z`), lease: m[4] ?? null };
}

/**
 * Whether a lane's work is safe: nothing uncommitted, and its commits pushed or merged. After
 * a squash merge GitHub deletes the branch, so the commits are on no remote any more; they are
 * safe when the PR was merged from this commit, or the base has the change (see mergedInto).
 */
export function workSafe(s: { dirty: number; unpushed: boolean; mergedHere: boolean }): boolean {
  return s.dirty === 0 && (!s.unpushed || s.mergedHere);
}

/** How long ago, in words a list can show: `5 min`, `3 h`, `2 d`. */
export function age(ms: number): string {
  if (ms < 3600_000) return `${Math.max(0, Math.round(ms / 60_000))} min`;
  if (ms < 48 * 3600_000) return `${Math.round(ms / 3600_000)} h`;
  return `${Math.round(ms / 86_400_000)} d`;
}
