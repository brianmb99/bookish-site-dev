#!/usr/bin/env bash
# Turns a deploy-workers tag into GitHub step outputs.
#
#   bash .github/scripts/parse-worker-tag.sh TAG
#
#   bookish-api-deploy-<bookish sha>[-note]  -> action=bookish-api, sha=<sha>
#   ops-deploy-<bookish sha>[-note]          -> action=ops, sha=<sha>
#   signups-pause-<note>                     -> action=signups-pause
#   signups-resume-<note>                    -> action=signups-resume
#
# The sha is a commit of brianmb99/bookish (7-40 hex characters); the deploy
# job checks that it is on bookish dev before deploying it.
set -euo pipefail

tag="${1:?usage: parse-worker-tag.sh TAG}"

if [[ "$tag" =~ ^(bookish-api|ops)-deploy-([0-9a-f]{7,40})(-[A-Za-z0-9._-]+)?$ ]]; then
  echo "action=${BASH_REMATCH[1]}"
  echo "sha=${BASH_REMATCH[2]}"
elif [[ "$tag" =~ ^signups-(pause|resume)-[A-Za-z0-9._-]+$ ]]; then
  echo "action=signups-${BASH_REMATCH[1]}"
  echo "sha="
else
  echo "Unrecognized tag '$tag'. Expected bookish-api-deploy-<bookish sha>, ops-deploy-<bookish sha>, signups-pause-<note>, or signups-resume-<note>." >&2
  exit 1
fi
