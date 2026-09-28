# Releasing Page Relay

## Release checklist

1. Update `version` in `manifest.json`.
2. Run the full test suite from the repository root:

   ```bash
   node --test tests/*.test.cjs
   node tests/browser-check.cjs
   node tests/provider-controls.cjs
   ```

3. Test the source directory locally in Chrome with **Load unpacked**.
4. Build the Chrome Web Store package:

   ```bash
   bash scripts/package.sh
   ```

5. Verify the generated ZIP as described below.
6. Load `release/` with **Load unpacked** for a final smoke test.
7. Upload `pagerelay-<version>.zip` to the Chrome Web Store.

## Packaging

Page Relay has no compilation or bundling step. `scripts/package.sh` reads the
version from `manifest.json`, recreates `release/` with only runtime files, and
creates `pagerelay-<version>.zip`. The ZIP must contain `manifest.json` at its
root, with no `release/` parent directory inside it.

## Verify the package

```bash
version=$(node -p 'require("./manifest.json").version')
unzip -l "pagerelay-$version.zip"
unzip -p "pagerelay-$version.zip" manifest.json
```

Confirm that `manifest.json` is at the ZIP root, its `version` matches the ZIP
filename, `release/` is not a parent directory inside the ZIP, development
files are absent, and only the required runtime icons are included.

## Final smoke test

After loading `release/` unpacked, check:

- A normal HTTPS page captures successfully.
- A long or dynamic page captures successfully.
- ChatGPT, Claude, and Gemini each prepare attachments.
- **Include page text** OFF prepares PNG only.
- **Include page text** ON prepares PNG and TXT.
- No message is sent automatically.
- `chrome://` pages remain unsupported.

## Runtime files

The ZIP contains these files at its root:

```text
manifest.json
sidepanel.html
panel.css
service-worker.js
panel.js
sidepanel-session.js
capture-layout.js
capture-preparation.js
content.js
page-text.js
ai-providers.js
chat-destinations.js
destinations-ui.js
provider-delivery.js
chatgpt-adapter.js
claude-adapter.js
gemini-adapter.js
```

It also contains these icons:

```text
assets/icons/icon-16.png
assets/icons/icon-32.png
assets/icons/icon-48.png
assets/icons/icon-128.png
```

## Files excluded from the Web Store ZIP

These repository and development files are intentionally excluded:

```text
tests/
README.md
RELEASING.md
INTEGRATIONS.md
PRIVACY.md
LICENSE
assets/icons/icon-1024.png
```

The release artifacts `release/` and `pagerelay-*.zip` are gitignored.

## Manual packaging / troubleshooting

If `scripts/package.sh` cannot run, use this fallback from the repository root:

```bash
rm -rf release
mkdir -p release/assets/icons
cp manifest.json sidepanel.html panel.css service-worker.js panel.js \
  sidepanel-session.js capture-layout.js capture-preparation.js content.js \
  page-text.js ai-providers.js chat-destinations.js destinations-ui.js \
  provider-delivery.js chatgpt-adapter.js claude-adapter.js gemini-adapter.js release/
cp assets/icons/icon-{16,32,48,128}.png release/assets/icons/
version=$(node -p 'require("./manifest.json").version')
rm -f "pagerelay-$version.zip"
(cd release && zip -q -r "../pagerelay-$version.zip" .)
unzip -l "pagerelay-$version.zip"
unzip -p "pagerelay-$version.zip" manifest.json
```
