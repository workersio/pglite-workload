#!/bin/sh
# Hermetic runner for pglite node workloads.
#
# The guest executes the committed git tree, where the extracted pglite package
# (build.sh output) is gitignored and absent, and the local convenience symlink
# .workers/vendor/pglite points at an absolute host path that does not exist in
# the guest. So we extract the committed npm tarball into /tmp (always writable)
# on first use and point the workload at it via PGLITE_BASE.
#
# Usage: sh .workers/workloads/_run.sh <workload.mjs> [--case <case>]
set -eu

HERE="$(cd "$(dirname "$0")" && pwd)"          # .workers/workloads
TARBALL="${HERE}/../vendor/electric-sql-pglite-0.5.4.tgz"
DIST=/tmp/pglite

if [ ! -f "${DIST}/dist/index.js" ]; then
  mkdir -p "${DIST}"
  # npm tarballs root everything under package/
  tar -xzf "${TARBALL}" -C "${DIST}" --strip-components=1
fi

export PGLITE_BASE="file://${DIST}/dist/"
exec node "$@"
