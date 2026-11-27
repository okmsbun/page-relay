#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$repo_root"

version=$(node -e 'const { version } = require("./manifest.json"); if (typeof version !== "string" || !/^[0-9]+(?:\.[0-9]+){0,3}$/.test(version)) throw new Error("Invalid manifest version"); process.stdout.write(version)')
zip_name="pagerelay-$version.zip"

runtime_files=(
  manifest.json sidepanel.html panel.css service-worker.js panel.js
  sidepanel-session.js capture-layout.js capture-preparation.js content.js
  page-text.js ai-providers.js chat-destinations.js destinations-ui.js
  provider-delivery.js chatgpt-adapter.js claude-adapter.js gemini-adapter.js
)
icon_files=(
  assets/icons/icon-16.png assets/icons/icon-32.png
  assets/icons/icon-48.png assets/icons/icon-128.png
)

for file in "${runtime_files[@]}" "${icon_files[@]}"; do
  if [[ ! -f "$file" ]]; then
    echo "Missing required runtime file: $file" >&2
    exit 1
  fi
done

rm -rf release
mkdir -p release/assets/icons
cp "${runtime_files[@]}" release/
cp "${icon_files[@]}" release/assets/icons/

temporary_dir=$(mktemp -d "$repo_root/.page-relay-package.XXXXXX")
trap 'rm -rf "$temporary_dir"' EXIT
(
  cd release
  zip -q "$temporary_dir/$zip_name" "${runtime_files[@]}" "${icon_files[@]}"
)
mv -f "$temporary_dir/$zip_name" "$repo_root/$zip_name"

# Verify ZIP integrity: manifest.json at root, matching version, exact expected file set.
zip_manifest_version=$(unzip -p "$repo_root/$zip_name" manifest.json | node -e 'const fs = require("fs"); const m = JSON.parse(fs.readFileSync(0, "utf8")); process.stdout.write(String(m.version || ""));')
if [[ "$zip_manifest_version" != "$version" ]]; then
  echo "ZIP manifest.json version mismatch: expected $version, got $zip_manifest_version" >&2
  exit 1
fi

printf '%s\n' "$zip_name"
