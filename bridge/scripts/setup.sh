#!/usr/bin/env bash
# Fetch the pinned upstream sources, apply the balloon patch, and build pigeon-bridge.
# Needs: git, make, perl, python3, cargo (brew install rust), protoc, Xcode Command Line Tools.
# Re-runnable: each step skips work that is already done.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck disable=SC1091
source "$ROOT/pins.env"
CORTEN="$ROOT/.build/corten"
CRATE="$CORTEN/pkg/rustpushgo"

case "$ROOT" in *" "*) echo "error: the project path contains spaces, which Corten's build cannot handle" >&2; exit 1 ;; esac

if [ ! -d "$CORTEN/.git" ]; then
  mkdir -p "$ROOT/.build"
  git clone --filter=blob:none "$CORTEN_REPO" "$CORTEN"
fi
if [ "$(git -C "$CORTEN" rev-parse HEAD)" != "$CORTEN_COMMIT" ]; then
  git -C "$CORTEN" fetch origin "$CORTEN_COMMIT"
  git -C "$CORTEN" checkout -q "$CORTEN_COMMIT"
fi

# Start from a pristine wrapper so our patch always applies to the same text.
git -C "$CORTEN" checkout -- pkg/rustpushgo/src/lib.rs

# Clones OpenBubbles/rustpush at Corten's pinned commit and applies Corten's own source patches.
make -C "$CORTEN" ensure-rustpush-source

python3 "$ROOT/patches/apply.py"

mkdir -p "$CRATE/src/bin"
cp "$ROOT/src/pigeon-bridge.rs" "$CRATE/src/bin/pigeon-bridge.rs"
mkdir -p "$CRATE/src/bin/pigeon_observations"
cp "$ROOT/src/pigeon_observations/mod.rs" "$CRATE/src/bin/pigeon_observations/mod.rs"

# Same flags as Corten's macOS from-source build: Apple's native framework generates validation data.
(cd "$CRATE" && MACOSX_DEPLOYMENT_TARGET=13.0 cargo build --release --bin pigeon-bridge \
  --no-default-features --features nac-apple-framework)

mkdir -p "$ROOT/.build/bin"
cp "$CRATE/target/release/pigeon-bridge" "$ROOT/.build/bin/pigeon-bridge"
echo "Built $ROOT/.build/bin/pigeon-bridge"
