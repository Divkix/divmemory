#!/usr/bin/env sh
set -eu
cd "$(dirname "$0")/../worker"

BACKUP_CREATED=false
ORIGINAL_EXISTS=false

cleanup() {
	if [ "$BACKUP_CREATED" = true ]; then
		mv .dev.vars.bak .dev.vars
	elif [ "$ORIGINAL_EXISTS" = false ]; then
		rm -f .dev.vars
	fi
}

trap cleanup EXIT INT TERM

if [ -f .dev.vars ]; then
	ORIGINAL_EXISTS=true
	mv .dev.vars .dev.vars.bak
	BACKUP_CREATED=true
fi

cat > .dev.vars <<'EOF'
DIVMEMORY_API_KEY=***********
DIVMEMORY_WEB_PASSWORD=*****************
COOKIE_SECRET=**********************
EOF

wrangler dev --port 8787
