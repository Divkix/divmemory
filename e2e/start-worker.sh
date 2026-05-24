#!/usr/bin/env sh
set -eu
cd "$(dirname "$0")/../worker"
cat > .dev.vars <<'EOF'
DIVMEMORY_API_KEY=e2e-api-key
DIVMEMORY_WEB_PASSWORD=e2e-test-password
COOKIE_SECRET=e2e-test-cookie-secret
EOF
exec wrangler dev --port 8787
