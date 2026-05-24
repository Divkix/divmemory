#!/usr/bin/env sh
set -eu
cd "$(dirname "$0")/../worker"

ORIGINAL_EXISTS=false
DEV_VARS_BAK_TMP=""

cleanup() {
	if [ -f .dev.vars.bak ]; then
		mv .dev.vars.bak .dev.vars
	elif [ "$ORIGINAL_EXISTS" = false ]; then
		rm -f .dev.vars
	fi
	if [ -n "$DEV_VARS_BAK_TMP" ] && [ -f "$DEV_VARS_BAK_TMP" ]; then
		mv "$DEV_VARS_BAK_TMP" .dev.vars.bak
	fi
}

trap cleanup EXIT INT TERM

if [ -f .dev.vars ]; then
	# Preserve any existing backup to avoid accidental overwrites
	if [ -f .dev.vars.bak ]; then
		DEV_VARS_BAK_TMP=".dev.vars.bak.$$"
		mv .dev.vars.bak "$DEV_VARS_BAK_TMP"
	fi
	mv .dev.vars .dev.vars.bak
	ORIGINAL_EXISTS=true
fi

cat > .dev.vars <<'EOF'
DIVMEMORY_API_KEY=***********
DIVMEMORY_WEB_PASSWORD=*****************
COOKIE_SECRET=**********************
EOF

wrangler dev --port 8787
