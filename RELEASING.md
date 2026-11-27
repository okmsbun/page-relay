# Releasing Page Relay

## Release checklist

1. Update `version` in `manifest.json` and the corresponding assertion in `tests/destinations.test.cjs`.
2. Update `CHANGELOG.md` and review `README.md`, `INTEGRATIONS.md`, and `PRIVACY.md` for accuracy.
3. Run the full test suite from the repository root:

   ```bash
   node --test tests/*.test.cjs
   node tests/browser-check.cjs
   node tests/provider-controls.cjs
   ```

4. Optionally run the isolated real-Chrome E2E check (`HEADLESS=1 node tests/sidepanel-e2e.cjs`) and test the source directory locally in Chrome with **Load unpacked**.
5. Build and validate the Chrome Web Store package:

   ```bash
   bash scripts/package.sh
   ```

6. Load `release/` with **Load unpacked** for a final smoke test.
7. Upload `pagerelay-<version>.zip` manually to the Chrome Web Store Developer Dashboard.

## GitHub Actions CI and Release Workflows

Page Relay uses four lightweight, dependency-free GitHub Actions workflows on `ubuntu-latest` with Node.js 24 LTS:

- `.github/workflows/quality.yml` — Checks JavaScript syntax (`node --check`), shell syntax (`bash -n`), `manifest.json` schema/permissions/icons, and verifies every runtime file referenced by `manifest.json`, `sidepanel.html`, and `panel.js` exists and is packaged by `scripts/package.sh`.
- `.github/workflows/test.yml` — Runs unit tests (`node --test tests/*.test.cjs`), headless Chrome browser fixtures (`node tests/browser-check.cjs`), and native pointer/keyboard provider control tests (`node tests/provider-controls.cjs`). Includes a conditional, allowlist-only disk cleanup step on GitHub-hosted runners when free root disk space drops below 10 GiB (preserving Chrome, Node.js, Git, `gh`, `zip`/`unzip`, and `dpkg` state).
- `.github/workflows/only-develop-to-main.yml` — Enforces that pull requests targeting `main` originate only from the `develop` branch within this repository (rejecting other branches and fork branches named `develop`). Pull requests targeting `develop` are unaffected.
- `.github/workflows/release.yml` — Triggered manually (`workflow_dispatch`) or on version tags (`v*`). On `v*` tags, verifies the tag matches `manifest.json` and points to a commit reachable from `main`, runs full quality and headless Chrome validation before building and validating `pagerelay-<version>.zip`, generating a `.sha256` checksum, uploading release artifacts, and (on `v*` tags) attaching them to a GitHub Release. It does **not** automatically publish to the Chrome Web Store.

### Required GitHub Branch Protection / Ruleset Configuration for `main`

To enforce the `develop -> main` release flow on GitHub:

1. Protect the `main` branch via **Settings → Branches** (or **Repository Rulesets**).
2. Require a pull request before merging to `main` and restrict direct pushes and force pushes.
3. Require status checks to pass before merging, selecting:
   - `quality` (from `Quality`)
   - `test` (from `Tests`)
   - `check-source-branch` (from `only-develop-to-main`)
4. Only create and push `v*` release tags from validated commits on `main` after the `develop -> main` pull request is merged.

## Packaging

Page Relay has no compilation or bundling step. `scripts/package.sh` reads the
version from `manifest.json`, recreates `release/` with only runtime files,
creates `pagerelay-<version>.zip`, and verifies that `manifest.json` is at the
ZIP root with matching version and zero extraneous files.

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
- **Recapture** returns to the pinned source tab and replaces the capture.
- Switching tabs shows **Captured** vs **Active tab** with **Capture this tab**; ungranted tabs display the calm **Page access required** state (preserving the previous capture) and continue automatically when clicking the Chrome toolbar icon.
- Switching tabs or manually scrolling mid-capture displays the calm **Capture interrupted** state while preserving any previous capture.
- `chrome://` and Chrome Web Store pages show the calm **Restricted page** state and recover cleanly when switching to a normal webpage.
- ChatGPT, Claude, and Gemini each prepare attachments cleanly (PNG-only, PNG+TXT, and PNG followed by TXT-only) without submitting any message automatically.

## Runtime files

The ZIP contains these 17 files at its root:

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

It also contains these 4 icons:

```text
assets/icons/icon-16.png
assets/icons/icon-32.png
assets/icons/icon-48.png
assets/icons/icon-128.png
```

## Files excluded from the Web Store ZIP

These repository and development files are intentionally excluded:

```text
.github/
docs/
scripts/
tests/
CHANGELOG.md
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
