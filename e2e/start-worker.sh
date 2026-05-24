#!/usr/bin/env sh
set -eu
cd "$(dirname "$0")/../worker"

BACKUP_CREATED=false
if [ -f .dev.vars ]; then
	mv .dev.vars .dev.vars.bak
	BACKUP_CREATED=true
fi

cleanup() {
	if [ "$BACKUP_CREATED" = true ]; then
		mv .dev.vars.bak .dev.vars
	else
		rm -f .dev.vars
	fi
}

trap cleanup EXIT INT TERM

cat > .dev.vars <<'EOF'
DIVMEMORY_API_KEY=e2e-api-key
DIVMEMORY_WEB_PASSWORD=e2e-test-password
COOKIE_SECRET=e2e-test-cookie-secret
EOF

wrangler dev --port 8787
