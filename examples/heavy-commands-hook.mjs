#!/usr/bin/env node
// A Claude Code PreToolUse hook (sample): inside a lane, a heavy command that does not go
// through `lane with build` is refused, with the command to use instead. Copy it somewhere,
// then add to .claude/settings.json (user or project):
//
//   "hooks": { "PreToolUse": [ { "matcher": "Bash", "hooks": [
//     { "type": "command", "command": "node /path/to/heavy-commands-hook.mjs" } ] } ] }
//
// Change HEAVY to the commands that are heavy on your machine.
import path from 'node:path';

const HEAVY = [
  /\bvitest\b/, /\bjest\b/, /\btsc\b/, /\b(npm|pnpm|yarn|bun) (run )?test\b/, /\bplaywright test\b/,
  /\bpytest\b/, /\bflutter (test|build)\b/, /\bgradlew?\b/, /\bcargo (build|test)\b/, /\bdotnet (build|test)\b/,
];

let input = '';
for await (const chunk of process.stdin) input += chunk;
let event;
try {
  event = JSON.parse(input);
} catch {
  process.exit(0);
}
const command = String(event?.tool_input?.command ?? '');
const cwd = path.resolve(String(event?.cwd ?? process.cwd()));
const root = process.env.LANE_ROOT ? path.resolve(process.env.LANE_ROOT) : '';
const inLane = root !== '' && cwd.toLowerCase().startsWith(root.toLowerCase() + path.sep);
if (!inLane || /\blane with\b/.test(command) || !HEAVY.some((re) => re.test(command))) process.exit(0);
process.stderr.write(
  'This is a heavy command: run it through the shared build slots, e.g.\n' +
  `  lane with build --cost 2 -- ${command}\n` +
  '(--cost 1 for a light one; run it in the background if the wait may be long)\n');
process.exit(2);
