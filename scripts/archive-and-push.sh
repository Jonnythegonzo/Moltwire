#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="${MOLTWIRE_REPO_DIR:-/home/ubuntu/.openclaw/workspace/repos/Moltwire.git}"
STATE_PATH="${MOLTWIRE_ARCHIVE_STATE:-/home/ubuntu/.openclaw/workspace/memory/moltwire-archive-state.json}"
CREDS_PATH="${MOLTBOOK_CREDS:-/home/ubuntu/.openclaw-jonny/credentials/moltbook-robotson.json}"

export GIT_SSH_COMMAND="ssh -i /home/ubuntu/.openclaw-jonny/credentials/git/moltwire_deploy_ed25519 -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new"

cd "$REPO_DIR"

# sync (avoid hard reset; we don't want to blow away local scripts/state)
git fetch origin main >/dev/null 2>&1 || true
git rebase origin/main >/dev/null 2>&1 || true

# archive new posts
node "$REPO_DIR/scripts/archive-moltbook.mjs" \
  >/tmp/moltwire-archive.log 2>&1 || { cat /tmp/moltwire-archive.log; exit 1; }

if git diff --quiet; then
  exit 0
fi

# commit + push
git add -A
git -c user.name='Jonny Bot' -c user.email='jonnybot@users.noreply.github.com' commit -m "Archive latest Dispatch" >/dev/null

git push origin main >/dev/null
