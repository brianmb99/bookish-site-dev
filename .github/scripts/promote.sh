#!/usr/bin/env bash
#
# Promote a bookish-site-dev checkout (what dev.getbookish.app serves) into a
# bookish-site checkout (getbookish.app), commit, and push.
#
# Usage:
#   bash .github/scripts/promote.sh SITE_DEV_DIR SITE_PROD_DIR [--dry-run]
#
# Copies everything except .git, .github, CNAME and README.md, deletes files
# production no longer has, sets CNAME to getbookish.app, and checks the
# result before committing. --dry-run commits locally but never pushes, and
# refuses a production checkout that has any git remote.
#
# Run by .github/workflows/release.yml. The push only happens in the
# "production" environment, after Brian approves.

set -euo pipefail

SRC="${1:?usage: promote.sh SITE_DEV_DIR SITE_PROD_DIR [--dry-run]}"
DEST="${2:?usage: promote.sh SITE_DEV_DIR SITE_PROD_DIR [--dry-run]}"
DRY_RUN=false
[[ "${3:-}" == "--dry-run" ]] && DRY_RUN=true

info() { printf '[promote] %s\n' "$1"; }
err()  { printf '[promote] ERROR: %s\n' "$1" >&2; }

SRC="$(cd "$SRC" && pwd)"
DEST="$(cd "$DEST" && pwd)"

[[ -d "$DEST/.git" ]] || { err "$DEST is not a git checkout"; exit 1; }
if $DRY_RUN && [[ -n "$(git -C "$DEST" remote)" ]]; then
  err "Dry run refuses a production checkout with a git remote: $DEST"
  exit 1
fi

for f in index.html sw.js 404.html CNAME; do
  [[ -f "$SRC/$f" ]] || { err "$SRC/$f is missing; is this a bookish-site-dev checkout?"; exit 1; }
done
if [[ "$(cat "$SRC/CNAME")" != "dev.getbookish.app" ]]; then
  err "$SRC/CNAME is not dev.getbookish.app; refusing to promote"
  exit 1
fi

app_version=$(grep -oE 'v[0-9]+\.[0-9]+\.[0-9]+' "$SRC/index.html" | sed -n 1p || true)
sw_version=$(sed -n "s/.*VERSION='\(v[0-9]*\)'.*/\1/p" "$SRC/sw.js")
src_sha=$(git -C "$SRC" rev-parse --short HEAD)
live_app=""
[[ -f "$DEST/index.html" ]] && live_app=$(grep -oE 'v[0-9]+\.[0-9]+\.[0-9]+' "$DEST/index.html" | sed -n 1p || true)
info "Promoting ${app_version:-?} (SW ${sw_version:-?}) from bookish-site-dev ${src_sha}; production is ${live_app:-empty}"

find "$DEST" -mindepth 1 -maxdepth 1 -not -name '.git' -not -name '.github' -exec rm -rf {} +
find "$SRC" -mindepth 1 -maxdepth 1 \
  -not -name '.git' -not -name '.github' -not -name 'CNAME' -not -name 'README.md' \
  -exec cp -R {} "$DEST/" \;

printf 'getbookish.app' > "$DEST/CNAME"

cat > "$DEST/README.md" <<EOF
# Bookish (Deployment Artifact)

This repository contains only the published static assets for the Bookish web application.

Source code, tests, tools, and private utilities live in a separate private repository.

Do not edit files here directly; changes will be overwritten on next publish.
Releases are promoted from brianmb99/bookish-site-dev by its Release production workflow.

Version: ${app_version} (SW ${sw_version}) from bookish-site-dev ${src_sha}
EOF

problems=()
[[ "$(cat "$DEST/CNAME")" == "getbookish.app" ]] || problems+=("CNAME is not getbookish.app")
[[ ! -e "$SRC/.nojekyll" || -e "$DEST/.nojekyll" ]] || problems+=(".nojekyll missing")
cmp -s "$DEST/index.html" "$DEST/404.html" || problems+=("404.html differs from index.html")
cmp -s "$SRC/sw.js" "$DEST/sw.js" || problems+=("sw.js differs from bookish-site-dev")
[[ ! -e "$DEST/.github/scripts/promote.sh" ]] || problems+=(".github was copied from bookish-site-dev")
if (( ${#problems[@]} > 0 )); then
  for p in "${problems[@]}"; do err "$p"; done
  exit 1
fi

cd "$DEST"
git add -A .
if git diff --cached --quiet; then
  info "Production already matches bookish-site-dev ${src_sha}; nothing to release"
  exit 0
fi
git commit -q -m "Deploy: $(date -u '+%Y-%m-%d %H:%M:%S') - ${app_version} (from bookish-site-dev ${src_sha})"
git --no-pager log -1 --shortstat --format='%s'

if $DRY_RUN; then
  info "Dry run: committed locally, not pushing"
  exit 0
fi
git push origin HEAD:main
info "Pushed. Live at https://getbookish.app in about a minute."
