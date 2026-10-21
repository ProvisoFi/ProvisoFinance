#!/usr/bin/env bash
# Installs the Foundry libraries into lib/ at pinned commits. lib/ is gitignored, so this
# file is the lock: bump a commit here (and re-run forge test) to upgrade a library.
# An existing lib/<name> is left alone; delete it to reinstall.
set -euo pipefail
cd "$(dirname "$0")"

fetch() { # name repo commit
  local dir="lib/$1"
  if [ -e "$dir" ]; then echo "skip $dir (exists)"; return; fi
  git init -q "$dir"
  git -C "$dir" remote add origin "https://github.com/$2"
  git -C "$dir" fetch -q --depth 1 origin "$3"
  git -C "$dir" checkout -q FETCH_HEAD
  # Direct submodules only, pinned by the parent's gitlinks (v4-core needs lib/solmate).
  git -C "$dir" submodule update -q --init --depth 1
  echo "$dir @ $3"
}

fetch forge-std foundry-rs/forge-std f3dae6e6ee381f25eb6a246f7da9b85c91a68219               # v1.17.0
fetch openzeppelin-contracts OpenZeppelin/openzeppelin-contracts c64a1edb67b6e3f4a15cca8909c9482ad33a02b0 # v5.4.0
fetch v4-core Uniswap/v4-core 46c6834698c48bc4a463a86d8420f4eb1d7f3b75                      # main, 2026-04-02
