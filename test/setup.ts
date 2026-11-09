// Preloaded into every test process (node --import): the suite may be run by a git hook, and the
// repository variables a hook exports would make every git call in the tests hit the hook's repository.
import { gitEnv } from '../src/git-env.ts';

const clean = gitEnv();
for (const key of Object.keys(process.env)) {
  if (!(key in clean)) delete process.env[key];
}
// trial
