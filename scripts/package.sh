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
printf '%s\n' "$zip_name"
