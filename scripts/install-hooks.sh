#!/bin/sh
# Install the repo's git hooks. Safe to re-run. Run from anywhere in the repo:
#   sh scripts/install-hooks.sh
root=$(git rev-parse --show-toplevel)
cp "$root/scripts/pre-push" "$root/.git/hooks/pre-push"
chmod +x "$root/.git/hooks/pre-push"
echo "Installed pre-push hook -> .git/hooks/pre-push"
