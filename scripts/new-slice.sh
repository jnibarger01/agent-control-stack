#!/usr/bin/env bash
# Start a slice of work in a fresh, isolated git worktree on a new branch cut from the current origin/main.
#
# Refuses (nonzero exit, nothing created) when the current checkout is dirty, when the branch already exists locally
# or on origin, when the worktree path already exists, or when local origin/main still differs from the remote main
# after fetching (a stale base). See AGENTS.md "Slice workflow".
set -euo pipefail

REMOTE="${NEW_SLICE_REMOTE:-origin}"
BASE_BRANCH="${NEW_SLICE_BASE_BRANCH:-main}"

usage() {
  cat <<USAGE
Usage: scripts/new-slice.sh [--dry-run] <branch> [worktree-path]

Fetches $REMOTE, then creates <branch> from the current $REMOTE/$BASE_BRANCH in a new worktree.
The default worktree path is <parent of the main checkout>/<repo>-<branch with / replaced by ->.

Options:
  --dry-run   Fetch and run every check, print what would be created, create nothing.
  -h, --help  Show this help.

Exit codes: 0 ok, 1 unexpected git failure, 2 usage, 3 dirty checkout, 4 fetch failed,
            5 stale base, 6 branch exists, 7 worktree path exists.
USAGE
}

die() {
  local code="$1"; shift
  echo "new-slice: $*" >&2
  exit "$code"
}

dry_run=0
positional=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) dry_run=1; shift ;;
    -h|--help) usage; exit 0 ;;
    --) shift; positional+=("$@"); break ;;
    -*) usage >&2; die 2 "unknown option: $1" ;;
    *) positional+=("$1"); shift ;;
  esac
done

if [[ ${#positional[@]} -lt 1 || ${#positional[@]} -gt 2 ]]; then
  usage >&2
  die 2 "expected <branch> and an optional [worktree-path]"
fi
branch="${positional[0]}"
worktree_path="${positional[1]:-}"

git rev-parse --is-inside-work-tree >/dev/null 2>&1 || die 2 "not inside a git work tree"
git check-ref-format --branch "$branch" >/dev/null 2>&1 || die 2 "invalid branch name: $branch"

# 1. The checkout this is launched from must be clean, so nothing half-done is silently left behind or mixed in.
dirty="$(git status --porcelain --untracked-files=normal)"
if [[ -n "$dirty" ]]; then
  echo "  ${dirty//$'\n'/$'\n  '}" >&2
  die 3 "current checkout is dirty; commit, move or discard these changes (or run from a clean checkout) first"
fi

# 2. Fetch, then prove local $REMOTE/$BASE_BRANCH equals what the remote reports right now.
echo "new-slice: fetching $REMOTE ..."
git fetch --prune "$REMOTE" >/dev/null 2>&1 || die 4 "git fetch $REMOTE failed; cannot prove the base is current"

base_ref="refs/remotes/$REMOTE/$BASE_BRANCH"
local_base="$(git rev-parse --verify --quiet "$base_ref^{commit}")" \
  || die 5 "$REMOTE/$BASE_BRANCH does not exist locally after fetch (check the remote's fetch refspec)"
remote_base="$(git ls-remote --exit-code "$REMOTE" "refs/heads/$BASE_BRANCH" 2>/dev/null | awk 'NR == 1 { print $1 }')" \
  || die 4 "cannot read refs/heads/$BASE_BRANCH from $REMOTE"
if [[ "$local_base" != "$remote_base" ]]; then
  die 5 "stale base: local $REMOTE/$BASE_BRANCH is ${local_base:0:12} but $REMOTE has ${remote_base:0:12}; fix the fetch (refspec/network) and retry"
fi

# 3. The branch must be new, both locally and on the remote.
if git show-ref --verify --quiet "refs/heads/$branch"; then
  die 6 "branch '$branch' already exists locally; pick a new slice name (one branch per slice)"
fi
if git show-ref --verify --quiet "refs/remotes/$REMOTE/$branch" \
  || [[ -n "$(git ls-remote --heads "$REMOTE" "refs/heads/$branch" 2>/dev/null)" ]]; then
  die 6 "branch '$branch' already exists on $REMOTE; pick a new slice name or continue in that branch's own worktree"
fi

# 4. The worktree path must be unused, on disk and in git's worktree registry.
common_dir="$(cd "$(git rev-parse --git-common-dir)" && pwd -P)"
main_checkout="$(dirname "$common_dir")"
if [[ -z "$worktree_path" ]]; then
  worktree_path="$(dirname "$main_checkout")/$(basename "$main_checkout")-${branch//\//-}"
fi
case "$worktree_path" in
  /*) ;;
  *) worktree_path="$PWD/$worktree_path" ;;
esac
if [[ -e "$worktree_path" || -L "$worktree_path" ]]; then
  die 7 "worktree path already exists: $worktree_path"
fi
if git worktree list --porcelain | grep -Fxq "worktree $worktree_path"; then
  die 7 "worktree path is still registered with git (run 'git worktree prune' if it was deleted): $worktree_path"
fi

if [[ "$dry_run" == 1 ]]; then
  echo "new-slice: dry run, nothing created"
  echo "  branch:   $branch"
  echo "  base:     $REMOTE/$BASE_BRANCH @ $local_base"
  echo "  worktree: $worktree_path"
  exit 0
fi

git worktree add --quiet --no-track -b "$branch" "$worktree_path" "$local_base" \
  || die 1 "git worktree add failed"
created_head="$(git -C "$worktree_path" rev-parse HEAD)"
[[ "$created_head" == "$local_base" ]] || die 1 "new worktree HEAD $created_head does not match base $local_base"

cat <<DONE
new-slice: created branch '$branch' at $REMOTE/$BASE_BRANCH (${local_base:0:12})
  worktree: $worktree_path

Next:
  cd "$worktree_path"
  # ...work, commit with path-scoped staging...
  node scripts/pr-preflight.mjs            # overlap, migration and staleness check
  git push -u $REMOTE "$branch" && gh pr create --draft
DONE
