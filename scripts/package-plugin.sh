#!/usr/bin/env bash
# Build an installable, versioned zip of the WordPress plugin: dist/annotate-<version>.zip
# The version comes from the plugin header; ANNOTATE_VERSION and readme.txt's Stable tag must match.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
src="$root/packages/wp-plugin"
main="$src/annotate/annotate.php"

header=$(sed -nE 's/^ \* Version: +([0-9][^ ]*)$/\1/p' "$main")
constant=$(sed -nE "s/^define\( 'ANNOTATE_VERSION', '([^']+)' \);$/\1/p" "$main")
stable=$(sed -nE 's/^Stable tag: *(.+)$/\1/p' "$src/annotate/readme.txt")
if [ -z "$header" ] || [ "$header" != "$constant" ] || [ "$header" != "$stable" ]; then
  echo "Version mismatch: header=$header ANNOTATE_VERSION=$constant readme Stable tag=$stable" >&2
  exit 1
fi

mkdir -p "$root/dist"
out="$root/dist/annotate-$header.zip"
rm -f "$out"
(cd "$src" && zip -qr "$out" annotate -x '*.DS_Store')
echo "$out"
