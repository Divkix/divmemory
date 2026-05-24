#!/usr/bin/env sh
set -eu
cd "$(dirname "$0")/../worker"

ORIGINAL_EXISTS=false
DEV_VARS_BAK_TMP=""

cleanup() {
	if [ "$ORIGINAL_EXISTS" = true ] && [ -f .dev.vars.bak ]; then
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
	ORIGINAL_EXISTS=true
	# Preserve any existing backup to avoid accidental overwrites
	if [ "$ORIGINAL_EXISTS" = true ] && [ -f .dev.vars.bak ]; then
		DEV_VARS_BAK_TMP=".dev.vars.bak.$$"
		mv .dev.vars.bak "$DEV_VARS_BAK_TMP"
	fi
	mv .dev.vars .dev.vars.bak
fi

: "${DIVMEMORY_API_KEY:=e2e-api-key}"
: "${DIVMEMORY_WEB_PASSWORD:=e2e-test-password}"
: "${COOKIE_SECRET:=e2e-test-cookie-secret}"

{
	printf 'DIVMEMORY_API_KEY=%s\n' "$DIVMEMORY_API_KEY"
	printf 'DIVMEMORY_WEB_PASSWORD=%s\n' "$DIVMEMORY_WEB_PASSWORD"
	printf 'COOKIE_SECRET=%s\n' "$COOKIE_SECRET"
} > .dev.vars

bun wrangler dev --port 8787
