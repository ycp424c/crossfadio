#!/usr/bin/env sh
set -eu

TEST_NODE_VERSION="${CROSSFADIO_TEST_NODE_VERSION:-20.19.5}"

run_vitest() {
  pnpm exec vitest run "$@"
}

can_load_better_sqlite3() {
  node -e "const Database = require('better-sqlite3'); const db = new Database(':memory:'); db.close();" >/dev/null 2>&1
}

if can_load_better_sqlite3; then
  run_vitest "$@"
  exit $?
fi

if command -v fnm >/dev/null 2>&1; then
  # better-sqlite3 is a native dependency; this workspace is built against Node 20.
  eval "$(fnm env)"
  if fnm use "$TEST_NODE_VERSION" >/dev/null 2>&1 && can_load_better_sqlite3; then
    echo "Using Node $(node -p 'process.version') for tests"
    run_vitest "$@"
    exit $?
  fi
fi

cat >&2 <<EOF
Cannot load better-sqlite3 with the current Node runtime.

Run tests with:
  eval "\$(fnm env)" && fnm use $TEST_NODE_VERSION && pnpm test

Or rebuild native dependencies for this Node:
  pnpm rebuild better-sqlite3
EOF
exit 1
