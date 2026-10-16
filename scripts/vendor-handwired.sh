#!/bin/sh
# Copies the handwired files that src/ imports into vendor/handwired, from github.com/chenglou/handwired at a commit.
# Usage: scripts/vendor-handwired.sh <commit>
set -eu
commit=${1:?usage: scripts/vendor-handwired.sh <commit>}
base=https://raw.githubusercontent.com/chenglou/handwired/$commit
dir=$(dirname "$0")/../vendor/handwired
for f in LICENSE src/runtime/numeric-ui-core.ts src/json-search/emit.ts; do
  mkdir -p "$dir/$(dirname "$f")"
  curl -fsSL "$base/$f" -o "$dir/$f"
done
sed -i.bak "s/^Commit: .*/Commit: \`$commit\`/" "$dir/README.md" && rm "$dir/README.md.bak"
echo "vendor/handwired is now at $commit"
