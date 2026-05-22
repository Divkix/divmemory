#!/bin/sh

payload=$(cat)
if ! command -v node >/dev/null 2>&1; then
	printf '%s\n' "[divmemory] node is required for the SessionStart hook." >&2
	exit 1
fi

cwd=$(node -e 'try { const payload = JSON.parse(process.argv[1] || ""); if (typeof payload.cwd === "string" && payload.cwd.trim()) process.stdout.write(payload.cwd); } catch {}' "$payload")
if [ -z "$cwd" ]; then
	cwd=$(pwd)
fi

remote=$(git -C "$cwd" remote get-url origin 2>/dev/null || true)
if [ -n "$remote" ]; then
	project=$(printf '%s' "$remote" \
		| sed 's/\.git$//; s:/*$::' \
		| tr '[:upper:]' '[:lower:]' \
		| sed -E 's#^[a-z]+://##')
	case "$project" in
		git@*) project=$(printf '%s' "$project" | sed 's/^git@//; s/:/\//') ;;
	esac
else
	# Fallback: local-<hash>-<basename> (match Node implementation)
	abs_path=$(cd "$cwd" && pwd)
	hash=$(printf '%s' "$abs_path" | sha256sum)
	if [ $? -ne 0 ] || [ -z "$hash" ]; then
		printf '%s\n' "[divmemory] failed to compute sha256 hash of project path." >&2
		exit 1
	fi
	hash=$(printf '%s' "$hash" | cut -c1-12)
	basename=$(basename "$abs_path")
	project="local-${hash}-${basename}"
fi

if [ -n "$project" ]; then
	encoded=$(node -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' "$project")
	if [ $? -ne 0 ] || [ -z "$encoded" ]; then
		printf '%s\n' "[divmemory] failed to encode project cache key." >&2
		exit 1
	fi
	home_dir="${DIVMEMORY_HOME:-$HOME/.divmemory}"
	cache_file="$home_dir/cache/$encoded.txt"
	if [ -s "$cache_file" ]; then
		cat "$cache_file"
		exit 0
	fi
fi

printf '%s' "$payload" | node "${CLAUDE_PLUGIN_ROOT}/hooks/session-start.mjs"
