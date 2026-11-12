#!/bin/sh
# 从环境变量生成 .dev.vars（wrangler dev 只通过 .dev.vars 暴露 secret 给本地 Worker）
set -eu
: "${ADMIN_TOKEN:?ADMIN_TOKEN env is required}"
printf 'ADMIN_TOKEN=%s\n' "$ADMIN_TOKEN" > /app/worker/.dev.vars
exec npx wrangler dev --local --ip 0.0.0.0 --port 8787
