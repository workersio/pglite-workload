#!/bin/sh
set -eu

# Base-image preparation for the PGlite workload harness.
#
# The system under test is the vendored published package (prebuilt WASM
# Postgres, zero runtime dependencies) — no monorepo toolchain (pnpm,
# emscripten) is required in the image. Workloads are node scripts driving
# the extracted package. Everything is offline — the tarball travels in git.

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PGLITE_VERSION="0.5.4"
TARBALL="${ROOT}/.workers/vendor/electric-sql-pglite-${PGLITE_VERSION}.tgz"
DEST="${ROOT}/.workers/vendor/node_modules/@electric-sql/pglite"

if [ ! -f "${TARBALL}" ]; then
  echo "missing vendored pglite tarball at ${TARBALL}" >&2
  exit 1
fi

rm -rf "${DEST}"
mkdir -p "${DEST}"
# npm tarballs root everything under package/
tar -xzf "${TARBALL}" -C "${DEST}" --strip-components=1

# Stable path for workloads regardless of vendor layout changes.
ln -sfn "${DEST}" "${ROOT}/.workers/vendor/pglite"

# Smoke-test where node is available; workloads run on the alpine-node image
# either way, so a node-less build host only defers this check.
if command -v node >/dev/null 2>&1; then
  node --input-type=module -e "
    const { PGlite } = await import('${DEST}/dist/index.js');
    const db = new PGlite();
    const r = await db.query('select 1 as one');
    console.log('pglite smoke:', JSON.stringify(r.rows));
  "
else
  echo "node not present on build host — smoke test deferred to workload runtime"
fi

echo "build.sh: pglite ${PGLITE_VERSION} staged at .workers/vendor/pglite"
