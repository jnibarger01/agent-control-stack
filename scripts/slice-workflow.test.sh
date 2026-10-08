#!/usr/bin/env bash
# Sandbox test for scripts/new-slice.sh and scripts/pr-preflight.mjs.
# Builds throwaway git repos with a bare "origin" under a temp dir and puts a fake `gh` first on PATH, so it never
# touches the real repository, its remote, or GitHub.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NEW_SLICE="$ROOT/scripts/new-slice.sh"
PREFLIGHT="$ROOT/scripts/pr-preflight.mjs"
TMP_ROOT="$(mktemp -d)"
trap '[[ -n "${KEEP_SANDBOX:-}" ]] || rm -rf "$TMP_ROOT"' EXIT
failures=0

# Hermetic git: no user/system config, fixed identity.
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
export GIT_AUTHOR_NAME=test GIT_AUTHOR_EMAIL=test@example.invalid
export GIT_COMMITTER_NAME=test GIT_COMMITTER_EMAIL=test@example.invalid
unset GIT_DIR GIT_WORK_TREE

fail() { echo "  FAIL: $*"; failures=$((failures + 1)); }
ok() { echo "  ok: $*"; }

show_out() { echo "      ${OUT//$'\n'/$'\n      '}"; }
# expect_exit <code> <desc> <cmd...>: runs cmd, captures output in $OUT, checks the exit code.
expect_exit() {
  local want="$1" desc="$2"; shift 2
  OUT="$("$@" 2>&1)"; local got=$?
  if [[ "$got" == "$want" ]]; then ok "$desc"; else fail "$desc (exit $got, want $want)"; show_out; fi
}
expect_out() {
  local desc="$1" pattern="$2"
  if grep -Eq -- "$pattern" <<<"$OUT"; then ok "$desc"; else fail "$desc (no match for /$pattern/)"; show_out; fi
}
expect_true() { local desc="$1"; shift; if "$@" >/dev/null 2>&1; then ok "$desc"; else fail "$desc"; fi; }
expect_false() { local desc="$1"; shift; if "$@" >/dev/null 2>&1; then fail "$desc"; else ok "$desc"; fi; }

# --- fake gh: serves $FAKE_GH_DIR/list.json and $FAKE_GH_DIR/view-<n>.json, fails when $FAKE_GH_DIR/fail exists ---
FAKE_BIN="$TMP_ROOT/bin"; mkdir -p "$FAKE_BIN"
cat >"$FAKE_BIN/gh" <<'GH'
#!/usr/bin/env bash
echo "gh $*" >>"$FAKE_GH_DIR/calls.log"
[[ -e "$FAKE_GH_DIR/fail" ]] && { echo "gh: not authenticated" >&2; exit 1; }
case "$1 $2" in
  "pr list") cat "$FAKE_GH_DIR/list.json" ;;
  "pr view") cat "$FAKE_GH_DIR/view-$3.json" ;;
  *) echo "fake gh: unsupported: $*" >&2; exit 1 ;;
esac
GH
chmod +x "$FAKE_BIN/gh"
export PATH="$FAKE_BIN:$PATH"

# --- sandbox: bare origin with main (migrations 001, 002), plus a clone "work" ---------------------------------
setup() {
  SANDBOX="$TMP_ROOT/$1"; mkdir -p "$SANDBOX"
  export FAKE_GH_DIR="$SANDBOX/gh"; mkdir -p "$FAKE_GH_DIR"; echo '[]' >"$FAKE_GH_DIR/list.json"
  git init -q --bare -b main "$SANDBOX/origin.git"
  git init -q -b main "$SANDBOX/seed"
  (
    cd "$SANDBOX/seed" || exit 1
    mkdir -p storage/migrations src
    echo "create table a(id);" >storage/migrations/001_a.sql
    echo "create table b(id);" >storage/migrations/002_b.sql
    echo "one" >src/shared.ts
    echo "two" >src/other.ts
    git add . && git commit -q -m init && git remote add origin "$SANDBOX/origin.git" && git push -q origin main
  )
  git clone -q "$SANDBOX/origin.git" "$SANDBOX/work"
  WORK="$SANDBOX/work"
}

# Advance origin/main from the seed clone.
push_to_main() {
  (cd "$SANDBOX/seed" && echo "$1" >>src/other.ts && git commit -q -am "main: $1" && git push -q origin main)
}

pr_json() { # pr_json <number> <branch> <file>...  (one open PR object)
  local n="$1" branch="$2"; shift 2
  local files="" sep="" f
  for f in "$@"; do files+="$sep{\"path\":\"$f\",\"additions\":1,\"deletions\":0}"; sep=","; done
  printf '{"number":%s,"title":"pr %s","headRefName":"%s","isDraft":true,"url":"https://example.invalid/pull/%s","changedFiles":%s,"files":[%s]}' \
    "$n" "$n" "$branch" "$n" "$#" "$files"
}

echo "new-slice.sh"

setup happy
expect_exit 0 "happy path creates a worktree" bash -c "cd '$WORK' && '$NEW_SLICE' feat/one '$SANDBOX/wt-one'"
expect_true "worktree exists" test -d "$SANDBOX/wt-one"
expect_true "branch is at origin/main" test "$(git -C "$SANDBOX/wt-one" rev-parse HEAD)" = "$(git -C "$SANDBOX/origin.git" rev-parse main)"
expect_true "worktree is on the new branch" test "$(git -C "$SANDBOX/wt-one" rev-parse --abbrev-ref HEAD)" = "feat/one"
expect_false "new branch has no upstream" git -C "$SANDBOX/wt-one" rev-parse --abbrev-ref '@{upstream}'
expect_exit 0 "default worktree path is a sibling of the main checkout" bash -c "cd '$WORK/src' && '$NEW_SLICE' feat/two"
expect_true "default path is <repo>-<branch>" test -d "$SANDBOX/work-feat-two"
expect_exit 0 "runs from inside a linked worktree, default path still beside the main checkout" \
  bash -c "cd '$SANDBOX/wt-one' && '$NEW_SLICE' feat/three"
expect_true "linked-worktree default path" test -d "$SANDBOX/work-feat-three"

setup fresh-after-push
push_to_main "later"
expect_exit 0 "fetches before branching" bash -c "cd '$WORK' && '$NEW_SLICE' feat/fresh '$SANDBOX/wt'"
expect_true "base is the newly pushed origin/main, not the stale clone state" \
  test "$(git -C "$SANDBOX/wt" rev-parse HEAD)" = "$(git -C "$SANDBOX/origin.git" rev-parse main)"

setup dry-run
expect_exit 0 "--dry-run succeeds" bash -c "cd '$WORK' && '$NEW_SLICE' --dry-run feat/dry '$SANDBOX/wt'"
expect_out "--dry-run reports the plan" "dry run, nothing created"
expect_false "--dry-run creates no worktree" test -e "$SANDBOX/wt"
expect_false "--dry-run creates no branch" git -C "$WORK" show-ref --verify --quiet refs/heads/feat/dry

setup dirty
echo "edit" >>"$WORK/src/shared.ts"
expect_exit 3 "refuses a dirty checkout (modified file)" bash -c "cd '$WORK' && '$NEW_SLICE' feat/x '$SANDBOX/wt'"
expect_out "dirty message" "current checkout is dirty"
git -C "$WORK" checkout -q -- src/shared.ts
touch "$WORK/untracked.txt"
expect_exit 3 "refuses a dirty checkout (untracked file)" bash -c "cd '$WORK' && '$NEW_SLICE' feat/x '$SANDBOX/wt'"
expect_false "nothing created when dirty" test -e "$SANDBOX/wt"

setup branch-exists
git -C "$WORK" branch feat/local
expect_exit 6 "refuses an existing local branch" bash -c "cd '$WORK' && '$NEW_SLICE' feat/local '$SANDBOX/wt'"
expect_out "local branch message" "already exists locally"
(cd "$SANDBOX/seed" && git push -q origin main:refs/heads/feat/remote)
expect_exit 6 "refuses a branch that exists only on origin" bash -c "cd '$WORK' && '$NEW_SLICE' feat/remote '$SANDBOX/wt'"
expect_out "remote branch message" "already exists on origin"
expect_false "nothing created for existing branch" test -e "$SANDBOX/wt"

setup worktree-exists
mkdir -p "$SANDBOX/taken"
expect_exit 7 "refuses an existing worktree path" bash -c "cd '$WORK' && '$NEW_SLICE' feat/x '$SANDBOX/taken'"
expect_false "no branch created when the path is taken" git -C "$WORK" show-ref --verify --quiet refs/heads/feat/x

setup stale
# A narrowed fetch refspec means `git fetch origin` no longer updates origin/main: local origin/main goes stale.
git -C "$WORK" config remote.origin.fetch '+refs/heads/main:refs/remotes/origin/elsewhere'
push_to_main "moved"
expect_exit 5 "refuses a stale base" bash -c "cd '$WORK' && '$NEW_SLICE' feat/x '$SANDBOX/wt'"
expect_out "stale message" "stale base"
expect_false "nothing created on stale base" test -e "$SANDBOX/wt"

setup fetch-fails
git -C "$WORK" remote set-url origin "$SANDBOX/missing.git"
expect_exit 4 "refuses when fetch fails" bash -c "cd '$WORK' && '$NEW_SLICE' feat/x '$SANDBOX/wt'"

setup usage
expect_exit 2 "missing branch is a usage error" bash -c "cd '$WORK' && '$NEW_SLICE'"
expect_exit 2 "invalid branch name is a usage error" bash -c "cd '$WORK' && '$NEW_SLICE' 'bad..name'"
expect_exit 2 "unknown option is a usage error" bash -c "cd '$WORK' && '$NEW_SLICE' --nope feat/x"
expect_exit 2 "outside a repo is a usage error" bash -c "cd '$SANDBOX' && '$NEW_SLICE' feat/x"

echo "pr-preflight.mjs"

# Branch "feat/mine" in WORK touching src/shared.ts.
setup_branch() {
  setup "$1"
  git -C "$WORK" checkout -q -b feat/mine
  echo "mine" >>"$WORK/src/shared.ts"
  git -C "$WORK" commit -q -am "touch shared"
}

setup_branch clean
expect_exit 0 "clean branch with no open PRs passes" bash -c "cd '$WORK' && node '$PREFLIGHT'"
expect_out "reports ahead/behind" "1 ahead, 0 behind origin/main"
expect_out "reports next migration" "next free migration number: 003"

setup_branch overlap
{ echo "["; pr_json 11 feat/theirs src/shared.ts; echo ","; pr_json 12 feat/unrelated src/other.ts; echo "]"; } >"$FAKE_GH_DIR/list.json"
expect_exit 0 "overlap warns by default" bash -c "cd '$WORK' && node '$PREFLIGHT'"
expect_out "names the overlapping PR and file" "#11 \\(draft\\) feat/theirs"
expect_out "lists the shared file" "^    src/shared.ts"
if grep -q "#12" <<<"$OUT"; then fail "non-overlapping PR #12 reported"; else ok "non-overlapping PR not reported"; fi
expect_exit 5 "--strict refuses on overlap" bash -c "cd '$WORK' && node '$PREFLIGHT' --strict"

setup_branch own-pr
{ echo "["; pr_json 20 feat/mine src/shared.ts; echo "]"; } >"$FAKE_GH_DIR/list.json"
expect_exit 0 "the branch's own PR is not an overlap" bash -c "cd '$WORK' && node '$PREFLIGHT' --strict"
expect_out "own PR is identified" "this branch's open PR: #20"

setup_branch truncated
{ echo "["; pr_json 30 feat/big src/other.ts | sed 's/"changedFiles":1/"changedFiles":2/'; echo "]"; } >"$FAKE_GH_DIR/list.json"
echo '{"files":[{"path":"src/other.ts"},{"path":"src/shared.ts"}]}' >"$FAKE_GH_DIR/view-30.json"
expect_exit 5 "falls back to gh pr view when the list's file list is truncated" bash -c "cd '$WORK' && node '$PREFLIGHT' --strict"
expect_true "gh pr view was called" grep -q "gh pr view 30 --json files" "$FAKE_GH_DIR/calls.log"

setup_branch behind
push_to_main "ahead of you"
expect_exit 3 "refuses a branch behind origin/main" bash -c "cd '$WORK' && node '$PREFLIGHT'"
expect_out "behind message" "1 commit\\(s\\) behind origin/main"

setup_branch migration-main
echo "x" >"$WORK/storage/migrations/002_mine.sql"; git -C "$WORK" add storage/migrations && git -C "$WORK" commit -q -m mig
expect_exit 6 "refuses a migration number already on main" bash -c "cd '$WORK' && node '$PREFLIGHT'"
expect_out "main collision message" "002_mine.sql \\(number 002\\) collides with origin/main"

setup_branch migration-pr
{ echo "["; pr_json 40 feat/theirs storage/migrations/003_theirs.sql; echo "]"; } >"$FAKE_GH_DIR/list.json"
expect_exit 0 "--next-migration counts open PRs" bash -c "cd '$WORK' && node '$PREFLIGHT' --next-migration"
if [[ "$OUT" == "004" ]]; then ok "--next-migration prints 004"; else fail "--next-migration printed '$OUT', want 004"; fi
echo "x" >"$WORK/storage/migrations/003_mine.sql"; git -C "$WORK" add storage/migrations && git -C "$WORK" commit -q -m mig
expect_exit 6 "refuses a migration number used by an open PR (even without --strict)" bash -c "cd '$WORK' && node '$PREFLIGHT'"
expect_out "PR collision message" "collides with open PR #40: storage/migrations/003_theirs.sql"
git -C "$WORK" mv storage/migrations/003_mine.sql storage/migrations/004_mine.sql && git -C "$WORK" commit -q -m renumber
expect_exit 0 "the reserved next number passes" bash -c "cd '$WORK' && node '$PREFLIGHT' --strict"

setup_branch gh-fails
touch "$FAKE_GH_DIR/fail"
expect_exit 4 "fails closed when gh cannot list PRs" bash -c "cd '$WORK' && node '$PREFLIGHT'"
expect_exit 2 "unknown argument is a usage error" bash -c "cd '$WORK' && node '$PREFLIGHT' --bogus"

echo
if [[ "$failures" -gt 0 ]]; then
  echo "slice-workflow tests: $failures failure(s)"
  exit 1
fi
echo "slice-workflow tests: all passed"
