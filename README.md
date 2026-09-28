# Page Relay

A Chrome extension that captures a full-page screenshot and rendered page text,
then prepares the screenshot in your AI chats from Chrome's Side Panel. Page text
can be included as an optional TXT attachment.

It prepares the message - it never sends it for you. You review the draft and
submit it yourself.

## What it does

- Captures a full-page screenshot by scrolling the page once and stitching the
  segments, including internal scroll containers and split app/sidebar layouts.
- Extracts the rendered page text while capturing, so lazy-loaded and
  virtualized rows that only appear while scrolling are included.
- Preserves page context: fixed/sticky elements are handled, the original scroll
  position is restored, and the screenshot keeps the correct
  devicePixelRatio/Retina resolution.
- Prepares the PNG in a supported AI chat. Turn on **Include page text** to also
  attach a `.txt` file with extracted text and a title/URL header. Existing
  draft text and attachments stay in place; Page Relay never writes text into
  the message editor.
- Runs in Chrome's native Side Panel: one panel session per capture, and
  switching tabs afterwards does not replace the captured source.

Preparing means _drafting_, not sending. Page Relay never clicks Send, never
presses Enter, and never starts model generation. A successful preparation means
"the captured context is in that chat's draft"; you still press Send.

## Supported AI services

Only providers with a complete, verified composer-preparation integration are
listed in the UI:

- **ChatGPT** - `chatgpt.com`, `chat.openai.com`
- **Claude** - `claude.ai`
- **Gemini** - `gemini.google.com`

A provider only appears when such a chat is open in one of your tabs. Providers
without a verified integration are not listed at all; there are no
"discovery-only" entries.

## Installation from source

1. Clone the repository:
   `git clone https://github.com/<your-account>/page-relay.git`
2. Open `chrome://extensions` in Chrome (116 or newer).
3. Enable **Developer mode**.
4. Click **Load unpacked**.
5. Select the repository directory that contains `manifest.json`
   (the `page-relay` folder itself).

## Usage

1. Open the webpage you want to capture and keep that tab active.
2. Click the Page Relay toolbar icon to open the Side Panel. The capture starts
   automatically; keep the source tab active until it finishes.
3. Optionally turn on **Include page text**. It starts off for every new capture;
   enabling it after capture does not recapture the page.
4. Click **Refresh** to list the AI conversations open in your browser, and
   select one or more of them.
5. Click **Add to N chats**. Page Relay attaches the PNG, plus TXT only when
   selected, alongside existing attachments and draft text.
6. Review each prepared chat and press Send there yourself.

Existing drafts and attachments are preserved. When included, TXT starts with
the page title and source URL, plus a truncation note if extraction reached a
technical limit. The extracted text below that header is unchanged. No delivery
ID is put in its contents.

ChatGPT and Claude prepare concurrently, with destinations within each provider
processed in order. Gemini runs afterward with coordinated tab activation.
Repeated actions for the same capture cannot duplicate a completed or uncertain
preparation. If preservation or upload completion cannot be confirmed, inspect
the Needs review result before doing anything else.

## Privacy

Page Relay runs entirely inside your browser, has no server or backend, and
collects no analytics. Captured page data stays in memory and is only placed into
the AI chats you explicitly select; those services then receive it under their own
terms. See [PRIVACY.md](PRIVACY.md) for details.

## Development / Tests

There are no build steps and no runtime dependencies - the extension is plain
JavaScript loaded unpacked from this directory.

```bash
node --test tests/*.test.cjs   # unit and integration tests
node tests/browser-check.cjs   # browser fixtures in headless Chrome
node tests/provider-controls.cjs # native pointer/keyboard checks in headless Chrome
```

`tests/sidepanel-e2e.cjs` is an optional, isolated end-to-end check that loads the
extension into a throwaway Chrome profile; it is not part of the default suite.

`INTEGRATIONS.md` documents the provider integrations and the required
verification before a provider is listed.

## License

MIT - see [LICENSE](LICENSE).

## Release / Chrome Web Store package

Page Relay has no compilation or bundling step. The Chrome Web Store ZIP is
created from runtime files only, with `manifest.json` at the ZIP root.

### Release workflow

1. Update `version` in `manifest.json`.
2. Run the full test suite:

   ```bash
   node --test tests/*.test.cjs
   node tests/browser-check.cjs
   node tests/provider-controls.cjs
   ```

3. Test the source directory locally in Chrome with **Load unpacked**.
4. Recreate `release/` with only runtime files:

   ```bash
   ./scripts/package.sh
   ```

5. The script creates `pagerelay-<manifest-version>.zip` with `manifest.json` at
   the ZIP root and prints its filename.
6. Verify the ZIP contents and version:

   ```bash
   version=$(node -p 'require("./manifest.json").version')
   unzip -l "pagerelay-$version.zip"
   unzip -p "pagerelay-$version.zip" manifest.json
   ```

   Confirm that `manifest.json` is at the root, its version matches the ZIP
   filename, and no development files are included.

7. Load `release/` with **Load unpacked** for a final smoke test: capture a
   normal page, prepare attachments in ChatGPT, Claude, and Gemini, and confirm
   that no message is sent automatically.
8. Upload the generated ZIP to the Chrome Web Store.

### Runtime files

The package contains these files at its root:

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

It also contains `assets/icons/icon-16.png`, `icon-32.png`, `icon-48.png`, and
`icon-128.png`. The Web Store ZIP excludes `tests/`, `README.md`,
`INTEGRATIONS.md`, `PRIVACY.md`, `LICENSE`, and
`assets/icons/icon-1024.png`. Both `release/` and `pagerelay-*.zip` are
gitignored.

### Manual packaging / troubleshooting

If the script cannot run, use the runtime list above from the repository root:

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

Check that the ZIP root contains `manifest.json`, the version matches, and only
the listed runtime files and icons are present before loading `release/` for the
final smoke test.
