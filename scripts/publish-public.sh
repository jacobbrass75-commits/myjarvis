#!/bin/zsh
# Publish a sanitized snapshot of this repo to the public GitHub repo, without touching your
# working tree or your private history.
#   scripts/publish-public.sh            # build + verify, then ask before pushing
#   scripts/publish-public.sh --yes      # push without asking
#   PUBLIC_REMOTE=https://github.com/<you>/<repo>.git scripts/publish-public.sh
#
# What it does, in a temporary git worktree of HEAD (committed files only, so .env, data and keys
# never come along):
#  1. applies ~/.g2-orchestrator/publish-private.json (kept OUTSIDE the repo): string replacements
#     for personal hardware ids, team id, bundle ids, and a "forbid" list that must not appear;
#  2. swaps the Bocchi avatar back to the reuse-with-credit Petdex sheet (momo-4) if the local one
#     has no license (assets/bocchi/pet.json "license" missing), and regenerates the lens frames;
#  3. refuses to continue if any .env value or forbidden string is still present;
#  4. commits the tree on top of the public repo's main (one commit per publish) and pushes it.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REMOTE="${PUBLIC_REMOTE:-https://github.com/jacobbrass75-commits/myjarvis.git}"
PRIVATE="$HOME/.g2-orchestrator/publish-private.json"
MSG="${PUBLISH_MESSAGE:-Release $(date +%Y-%m-%d)}"
[[ -f "$PRIVATE" ]] || { echo "Missing $PRIVATE (replacements + forbidden strings)."; exit 1; }
WT="$(mktemp -d)/myjarvis"
cleanup() { git -C "$ROOT" worktree remove --force "$WT" 2>/dev/null || true; }
trap cleanup EXIT
git -C "$ROOT" worktree add --detach "$WT" HEAD >/dev/null
cd "$WT"

python3 - "$PRIVATE" <<'PY'
import json, os, subprocess, sys
cfg = json.load(open(sys.argv[1]))
files = subprocess.run(["git", "ls-files"], capture_output=True, text=True).stdout.split("\n")
changed = 0
for f in filter(None, files):
    try:
        s = open(f, encoding="utf-8").read()
    except (UnicodeDecodeError, IsADirectoryError, FileNotFoundError):
        continue
    t = s
    for a, b in cfg["replace"]:
        t = t.replace(a, b)
    if t != s:
        open(f, "w", encoding="utf-8").write(t)
        changed += 1
print(f"sanitized {changed} files")
PY

# Avatar: only publish artwork whose license allows it.
if ! grep -q '"license"' assets/bocchi/pet.json 2>/dev/null; then
  # The reuse-with-credit sheet (Petdex momo-4) kept in assets/bocchi/previous-momo-4/.
  [[ -f assets/bocchi/previous-momo-4/spritesheet.webp ]] || { echo "No licensed avatar sheet; refusing to publish the unlicensed one."; exit 1; }
  for f in spritesheet.webp pet.json CREDITS.md; do cp "assets/bocchi/previous-momo-4/${f}" "assets/bocchi/${f}"; done
  rm -rf assets/bocchi/previous-momo-4
  python3 scripts/build-bocchi-sprite.py assets/bocchi/spritesheet.webp >/dev/null
  echo "avatar: published the licensed momo-4 sheet (your local avatar is unchanged)"
fi

# Verify: no .env value and no forbidden string anywhere in the snapshot.
python3 - "$PRIVATE" "$ROOT/.env" <<'PY'
import json, re, subprocess, sys
cfg = json.load(open(sys.argv[1]))
secrets = []
try:
    for line in open(sys.argv[2]):
        m = re.match(r"^([A-Z_]+)=(.*)$", line.strip())
        if m and len(m.group(2)) >= 12 and not m.group(2).startswith("openrouter:"):
            secrets.append(m.group(2).strip("\"'"))
except FileNotFoundError:
    pass
bad = []
for f in filter(None, subprocess.run(["git", "ls-files", "-mo", "--exclude-standard"], capture_output=True, text=True).stdout.split("\n") + subprocess.run(["git", "ls-files"], capture_output=True, text=True).stdout.split("\n")):
    try:
        s = open(f, encoding="utf-8", errors="ignore").read()
    except (IsADirectoryError, FileNotFoundError):
        continue
    for v in secrets:
        if v in s: bad.append(f"{f}: an .env value")
    for v in cfg["forbid"]:
        if v.lower() in s.lower(): bad.append(f"{f}: forbidden string #{cfg['forbid'].index(v)}")
if bad:
    print("REFUSING TO PUBLISH:\n  " + "\n  ".join(sorted(set(bad))[:40])); sys.exit(1)
print("verify: no secrets or private strings")
PY

# The sanitized G2Kit (its tests use the fake hardware ids) must still pass. SKIP_TESTS=1 skips.
if [[ -z "${SKIP_TESTS:-}" ]]; then
  (cd native/ios/G2Kit && swift test 2>&1 | grep -E "Test run with|✘" | tail -3)
  (cd native/ios/G2Kit && swift test >/dev/null 2>&1) || { echo "Sanitized G2Kit tests fail; not publishing."; exit 1; }
fi

git add -A
TREE=$(git write-tree)
if command -v gh >/dev/null; then GHCRED=(-c 'credential.helper=' -c 'credential.helper=!gh auth git-credential'); else GHCRED=(); fi
PARENT=$(git "${GHCRED[@]}" ls-remote "$REMOTE" refs/heads/main | cut -f1 || true)
if [[ -n "$PARENT" ]]; then
  git "${GHCRED[@]}" fetch -q "$REMOTE" main
  [[ "$(git rev-parse FETCH_HEAD^{tree})" == "$TREE" ]] && { echo "Public repo already matches; nothing to push."; exit 0; }
  COMMIT=$(git commit-tree "$TREE" -p FETCH_HEAD -m "$MSG")
else
  COMMIT=$(git commit-tree "$TREE" -m "$MSG")
fi
echo "commit $COMMIT ($(git ls-files | wc -l | tr -d ' ') files) -> $REMOTE main"
if [[ "${1:-}" != "--yes" ]]; then
  read "ok?Push to $REMOTE? [y/N] "; [[ "$ok" == y* ]] || { echo "Not pushed."; exit 0; }
fi
# Use the GitHub CLI's login for this push only (no global git config change), if gh is installed.
if command -v gh >/dev/null; then GHCRED=(-c 'credential.helper=' -c 'credential.helper=!gh auth git-credential'); else GHCRED=(); fi
git "${GHCRED[@]}" push "$REMOTE" "${COMMIT}:refs/heads/main"
echo "Published."
