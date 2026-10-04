#!/usr/bin/env bash
# Fetch OpenPigeon's pool engine and its Box2D fork at the pinned commits and build pool-sim.
# Needs: git and clang++ (Xcode Command Line Tools). Re-runnable.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck disable=SC1091
source "$ROOT/pins.env"
BUILD="$ROOT/.build"
OP="$BUILD/openpigeon"
B2="$BUILD/box2d"
OBJ="$BUILD/obj"
POOL="$OP/app/src/main/cpp/pool"

# Only the pool sources are checked out: the full repo is mostly artwork and audio we do not use.
if [ ! -d "$OP/.git" ]; then
  git init -q "$OP"
  git -C "$OP" remote add origin "$OPENPIGEON_REPO"
  git -C "$OP" sparse-checkout set app/src/main/cpp/pool
fi
if [ "$(git -C "$OP" rev-parse -q --verify HEAD 2>/dev/null || true)" != "$OPENPIGEON_COMMIT" ]; then
  git -C "$OP" fetch -q --depth 1 --filter=blob:none origin "$OPENPIGEON_COMMIT"
  git -C "$OP" checkout -q FETCH_HEAD
fi

if [ ! -d "$B2/.git" ]; then
  git init -q "$B2"
  git -C "$B2" remote add origin "$BOX2D_REPO"
fi
if [ "$(git -C "$B2" rev-parse -q --verify HEAD 2>/dev/null || true)" != "$BOX2D_COMMIT" ]; then
  git -C "$B2" fetch -q --depth 1 origin "$BOX2D_COMMIT"
  git -C "$B2" checkout -q FETCH_HEAD
fi

# Same floating-point flags as OpenPigeon's own build; the physics depends on them.
FLAGS=(-std=c++20 -O2 -fno-fast-math -ffp-contract=on -w)
mkdir -p "$OBJ" "$BUILD/bin"

# Box2D is compiled against its own headers, the engine against the fork's Include/ copy, as upstream does.
find "$B2/Box2D/Box2D" -name '*.cpp' | while read -r src; do
  obj="$OBJ/b2_$(echo "${src#"$B2/Box2D/Box2D/"}" | tr '/' '_').o"
  [ "$obj" -nt "$src" ] || clang++ "${FLAGS[@]}" -I"$B2/Box2D" -c "$src" -o "$obj"
done

clang++ "${FLAGS[@]}" -I"$ROOT/shim" -I"$B2/Include" -I"$POOL" \
  "$POOL/PoolTable.cpp" "$POOL/PoolBall.cpp" "$POOL/PoolContactListener.cpp" "$ROOT/src/main.cpp" \
  "$OBJ"/b2_*.o -o "$BUILD/bin/pool-sim"

echo "Built $BUILD/bin/pool-sim"
