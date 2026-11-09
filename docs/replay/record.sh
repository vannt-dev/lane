#!/bin/sh
# Records the replay on the landing page: real lane commands on a copy of dynamic-field-kit.
# Writes docs/replay/lane.jsonl, one {"cmd", "sec", "out"} per step ("gate" for the human step).
#
#   ROOT=F:/demo sh docs/replay/record.sh F:/ai-agent/dynamic-field-kit   # a short folder: short paths
#
# The origin is a bare copy in $ROOT, so nothing reaches the real repository; "you merge the pull
# request" is stood in for by pushing the branch into develop there.
set -e
ROOT="${ROOT:?set ROOT to a short empty folder}"
SRC="$1"
OUT="$(cd "$(dirname "$0")" && pwd)/lane.jsonl"
LANE="node $(cd "$(dirname "$0")/../.." && pwd)/bin/lane.ts"
export LANE_ROOT=$ROOT/wt LANE_REPOS=$ROOT/code LANE_LINK_DEPS=1
rm -rf $ROOT/wt $ROOT/code $ROOT/remote "$OUT"
git clone -q --bare "$SRC" $ROOT/remote/dfk.git
git clone -q $ROOT/remote/dfk.git $ROOT/code/dfk
git -C $ROOT/code/dfk remote set-head origin -a >/dev/null
printf 'npx vitest run --root packages/core\n' > $ROOT/code/dfk/.lanecheck
printf '.lanecheck\n' >> $ROOT/code/dfk/.git/info/exclude

json() { node -e 'const [c,s,o]=process.argv.slice(1);process.stdout.write(JSON.stringify({cmd:c,sec:Number(s),out:o})+"\n")' "$@"; }
# Runs a `lane ...` line with this checkout's lane and records it as typed.
step() {
  start=$(date +%s)
  out=$(cd $ROOT/code && eval "$LANE ${1#lane }" 2>&1) || true
  json "$1" "$(( $(date +%s) - start ))" "$out" >> "$OUT"
}
quiet() { (cd "$1" && shift && "$@") >/dev/null 2>&1; }

step "lane new dfk feat/forms"
step "lane new dfk feat/core --sparse packages/core --link-deps"
# the two agents work and push
echo "// validate on blur" >> $ROOT/wt/dfk-1/packages/react/src/index.ts
quiet $ROOT/wt/dfk-1 git commit -qam "feat(react): validate on blur"
# prettier rewrites the file with LF after the commit; git (autocrlf) then shows it changed
quiet $ROOT/wt/dfk-1 git reset -q --hard HEAD
quiet $ROOT/wt/dfk-1 git push -q origin feat/forms
echo "// keep values when a field is hidden" >> $ROOT/wt/dfk-2/packages/core/src/index.ts
quiet $ROOT/wt/dfk-2 git commit -qam "docs(core): note on hidden fields"
quiet $ROOT/wt/dfk-2 git push -q origin feat/core
json "# the two agents work and push" 0 "" >> "$OUT"
step "lane list --local"
step "lane verify dfk"
# the person merges feat/forms
quiet $ROOT/wt/dfk-1 git push -q origin feat/forms:develop
json "gate: you merge the pull request of feat/forms" 0 "" >> "$OUT"
step "lane sync dfk --push"
step "lane clean --yes --force"
step "lane list --local"
echo "recorded $(wc -l < "$OUT") steps to $OUT"
