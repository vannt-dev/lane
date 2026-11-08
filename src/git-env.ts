// What `git rev-parse --local-env-vars` lists, plus GIT_CONFIG_KEY_<n> / GIT_CONFIG_VALUE_<n>.
const LOCAL = new Set([
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_CONFIG',
  'GIT_CONFIG_PARAMETERS',
  'GIT_CONFIG_COUNT',
  'GIT_OBJECT_DIRECTORY',
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_IMPLICIT_WORK_TREE',
  'GIT_GRAFT_FILE',
  'GIT_INDEX_FILE',
  'GIT_NO_REPLACE_OBJECTS',
  'GIT_REPLACE_REF_BASE',
  'GIT_PREFIX',
  'GIT_SHALLOW_FILE',
  'GIT_COMMON_DIR',
]);

/** Env keys are case-insensitive on Windows only. */
function isLocal(key: string, upper: boolean): boolean {
  const k = upper ? key.toUpperCase() : key;
  return LOCAL.has(k) || /^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(k);
}

/**
 * The environment for running git on another repository. A git hook exports its own repository's
 * variables (GIT_DIR, GIT_INDEX_FILE, ...) to its children, and they override -C and cwd, so a
 * lane run from a hook would otherwise act on the hook's repository.
 */
export function gitEnv(extra: NodeJS.ProcessEnv = {}, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (!isLocal(key, process.platform === 'win32')) out[key] = value;
  }
  return { ...out, ...extra };
}
