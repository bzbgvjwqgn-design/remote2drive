#!/bin/sh
set -eu

PRISMA_CLI="./node_modules/prisma/build/index.js"

if [ "${RUN_MIGRATIONS:-false}" = "true" ]; then
  echo "[entrypoint] applying database migrations"
  if [ -f "$PRISMA_CLI" ]; then
    node "$PRISMA_CLI" migrate deploy
  else
    npx --no-install prisma migrate deploy
  fi
fi

echo "[entrypoint] starting role=${ROLE:-both} node=${NODE_ID:-$(hostname)}"
exec node dist/index.js
