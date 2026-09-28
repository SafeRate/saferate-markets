#!/usr/bin/env bash
# Vendor @saferate/treasury-client from saferate-treasury at a pinned commit.
#   bash scripts/bash/sync-treasury-client.sh main
#   bash scripts/bash/sync-treasury-client.sh <sha|branch>
#
# WHY VENDORED rather than installed. Measured 2026-09-28 with bun 1.4.0: bun
# rewrites every GitHub git URL (github:, git+https:) into an UNAUTHENTICATED
# tarball download, which a private repo answers with 404. Even authenticated it
# would install the repo ROOT (@saferate/treasury-monorepo), not packages/client,
# because bun has no subdirectory form for git dependencies.
#
# WHAT MAKES A COPY SAFE. saferate-treasury's apps/treasury-api/src/clientContract.ts
# fails tsc there when the client stops describing the real TreasuryService. So
# the copy at commit X is known to match treasury-api at commit X — and VENDORED
# below records X. It says nothing about which treasury-api is DEPLOYED, which is
# why the client's later-added methods stay optional.
#
# Do not edit packages/treasury-client/src by hand. Change it upstream and
# re-run this; a local edit is overwritten silently by the next sync.
set -euo pipefail

REF="${1:-}"
if [ -z "$REF" ]; then
	echo "usage: $0 <ref>   (a branch, tag or commit of SafeRate/saferate-treasury)" >&2
	exit 1
fi

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DEST="$ROOT/packages/treasury-client"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

git -C "$WORK" init --quiet
git -C "$WORK" remote add origin https://github.com/SafeRate/saferate-treasury.git
git -C "$WORK" fetch --quiet --depth 1 origin "$REF"
git -C "$WORK" checkout --quiet FETCH_HEAD
SHA="$(git -C "$WORK" rev-parse HEAD)"

SRC="$WORK/packages/client"
if [ ! -f "$SRC/src/client.ts" ]; then
	echo "error: $REF has no packages/client/src/client.ts" >&2
	exit 1
fi

rm -rf "$DEST/src" "$DEST/tests"
mkdir -p "$DEST"
cp -R "$SRC/src" "$SRC/tests" "$SRC/package.json" "$SRC/README.md" "$DEST/"

cat > "$DEST/VENDORED" <<EOT
repo:   SafeRate/saferate-treasury
path:   packages/client
ref:    $REF
commit: $SHA
synced: $(date -u +%Y-%m-%dT%H:%M:%SZ)
EOT

echo "vendored packages/client at $SHA ($REF)"
