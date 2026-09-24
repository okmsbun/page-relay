# PageRelay

A Chrome extension that captures a full-page screenshot plus the rendered page
text and prepares that context in your AI chats, from Chrome's Side Panel.

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
- Prepares that context in a supported AI chat: the PNG, a `.txt` file with the
  extracted text, and a short prompt are placed in that chat's composer.
- Runs in Chrome's native Side Panel: one panel session per capture, and
  switching tabs afterwards does not replace the captured source.

Preparing means _drafting_, not sending. PageRelay never clicks Send, never
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
2. Click the PageRelay toolbar icon to open the Side Panel. The capture starts
   automatically; keep the source tab active until it finishes.
3. Click **Refresh** to list the AI conversations open in your browser, and
   select one or more of them.
4. Click **Add to N chats**. PageRelay attaches the PNG and the extracted text
   and inserts the prompt into each selected chat's composer.
5. Review each prepared chat and press Send there yourself.

Existing drafts and attachments are never overwritten: if a chat already has
unsent text or an attachment, PageRelay reports it as Failed and changes nothing.

## Privacy

PageRelay runs entirely inside your browser, has no server or backend, and
collects no analytics. Captured page data stays in memory and is only placed into
the AI chats you explicitly select; those services then receive it under their own
terms. See [PRIVACY.md](PRIVACY.md) for details.

## Development / Tests

There are no build steps and no runtime dependencies - the extension is plain
JavaScript loaded unpacked from this directory.

```bash
node --test tests/*.test.cjs   # unit and integration tests
node tests/browser-check.cjs   # browser fixtures in headless Chrome
```

`tests/sidepanel-e2e.cjs` is an optional, isolated end-to-end check that loads the
extension into a throwaway Chrome profile; it is not part of the default suite.

`INTEGRATIONS.md` documents the provider integrations and the required
verification before a provider is listed.

## License

MIT - see [LICENSE](LICENSE).
