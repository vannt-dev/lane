// Where lane works, read once from the environment.
export const config = {
  /** The folder that holds the lanes (slots). */
  root: process.env.LANE_ROOT || 'F:/wt',
  /** The folder that holds the main clones; `<repo>` names one of them. */
  repos: process.env.LANE_REPOS || 'F:/ai-agent',
  /** Slots per repository; a full pool lists who holds what instead of taking a slot. */
  maxSlots: Number(process.env.LANE_MAX_SLOTS || 4),
  /** Ports per slot: slot n owns the usual port + n x stride, up to stride ports. */
  portStride: Number(process.env.LANE_PORT_STRIDE || 10),
};

/**
 * Speed flags passed per command, never written to the repository's config: checkout with
 * all cores, and remember which folders have no untracked files.
 */
export const FAST = ['-c', 'checkout.workers=0', '-c', 'core.untrackedCache=true'];

/** The repository's hooks off: lane's own merges and rebases are not commits for review. */
export const NO_HOOKS = ['-c', 'core.hooksPath=.lane-no-hooks', '-c', 'user.name=lane', '-c', 'user.email=lane@localhost'];

/**
 * Untracked files worth carrying over from the main clone. A repository adds more, one path
 * per line, in an untracked `.lanecopy` file at its root.
 */
export const COPY_DEFAULT = ['.env', '.env.local', 'android/key.properties', '.claude/settings.local.json'];
