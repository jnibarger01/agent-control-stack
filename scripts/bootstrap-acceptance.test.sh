#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

for path in \
  docs/platform-facts.md \
  docs/architecture.md \
  docs/sop.md \
  harness/routing.ts \
  harness/orchestration.ts \
  evals/runner.ts \
  evals/task-schema.ts \
  evals/tasks/auth-boundary-review.json \
  evals/graders/.gitkeep \
  skills/_templates/SKILL.md \
  runs/.gitignore \
  STATE.md; do
  [[ -f "$ROOT/$path" ]] || { echo "missing bootstrap artifact: $path" >&2; exit 1; }
done

for script in new-session end-session run-evals; do
  [[ -x "$ROOT/scripts/$script" ]] || { echo "script is not executable: scripts/$script" >&2; exit 1; }
done

"$ROOT/scripts/new-session" > "$TMP_DIR/new-session.out"
rg -q '^=== Session contract ===$' "$TMP_DIR/new-session.out"
rg -q '^=== STATE\.md ===$' "$TMP_DIR/new-session.out"
rg -q '^## General rules$' "$TMP_DIR/new-session.out"
rg -q 'No artifact without an acceptance check' "$TMP_DIR/new-session.out"
rg -q 'No platform-feature claim without a citation' "$TMP_DIR/new-session.out"
rg -q 'If blocked, document the block' "$TMP_DIR/new-session.out"

cat > "$TMP_DIR/empty-state.md" <<'EOF'
# Session state

## Last session

EOF

if STATE_FILE="$TMP_DIR/empty-state.md" "$ROOT/scripts/end-session" > "$TMP_DIR/end-session.out" 2>&1; then
  echo "end-session accepted an empty Last session" >&2
  exit 1
fi
rg -q 'Refusing to finish: STATE.md Last session is empty' "$TMP_DIR/end-session.out"

"$ROOT/scripts/run-evals" > "$TMP_DIR/run-evals.out"
rg -q '^Usage: scripts/run-evals ' "$TMP_DIR/run-evals.out"

git -C "$ROOT" check-ignore -q --no-index runs/artifacts/large.bin

echo "PASS bootstrap tree and session script acceptance"
