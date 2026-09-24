# Destination integrations

The UI stays in the popup. `content.js`, `page-text.js`, `capture-layout.js`, and
the capture pipeline in `popup.js` have no provider-specific behavior.

## Current capability

| Provider | Recognized chat routes | Sending |
| --- | --- | --- |
| ChatGPT | New chats, `/c/…`, custom GPT conversations | Enabled; existing user-confirmed adapter, regression fixtures |
| Claude | `/new`, `/chat/…` | Unavailable until signed-in UI verification |
| Gemini | `/app`, `/app/…`, account-prefixed `/u/N/app/…` | Unavailable until signed-in UI verification |
| DeepSeek | `/`, `/a/chat/s/…` | Unavailable until signed-in UI verification |
| Perplexity | `/`, `/search/…` | Unavailable until signed-in UI verification |
| Microsoft Copilot | `/`, `/chats/…` | Unavailable until signed-in UI verification |
| Grok | `/`, `/c/…`, `/chat/…` | Unavailable until signed-in UI verification |
| Mistral Le Chat | `/chat`, `/chat/…` | Unavailable until signed-in UI verification |

Recognition identifies a candidate from Chrome's URL and title, not a guarantee
that the tab is signed in or supports sending. Unknown routes, shared read-only
pages, and sign-in pages are excluded. New routes require verification before
adding them. No unverified provider has a guessed sending adapter.

The manifest's exact provider hosts allow title/URL discovery across accessible
windows without the broad `tabs` permission. There is no `<all_urls>`, debugger,
clipboard, or cookie permission. Incognito destinations require Chrome's
**Allow in Incognito** setting and are explicitly labelled.

`ai-providers.js` owns URL recognition and capability flags;
`chat-destinations.js` owns discovery, selection validation, and independent
results; `provider-delivery.js` dispatches to enabled adapters. Neither selecting
nor refreshing destinations injects a sending script. Disabled destinations
cannot bypass the capability check by invoking the queue directly.

## ChatGPT verification

The previous implementation held one editor reference and compared `innerText`
exactly. Replacing the editor or rewriting rich-text whitespace could trigger
the same error as a real edit. It also inspected outgoing turns only after its
own Send click, so an already-submitted capture could be misclassified.

The adapter now re-queries the current editor, normalizes presentation whitespace,
and distinguishes its synchronous insertion from trusted editing events. It
checks for the unique delivery marker plus expected prompt in an outgoing user
turn before evaluating draft changes. Both attachment names must be verified
on that turn, or both must have been ready immediately before the adapter's
single Send click. It waits briefly for delayed rendering without refilling or
resubmitting anything. Emptying the composer alone is never success.

Existing drafts and attachments still prevent preparation. Real edits, missing
attachment proof, and unconfirmed submissions remain **Needs review**, not Sent.
Review and successful rows stay disabled for the current capture, including a
refresh after a new-chat URL becomes a conversation URL. There is no automatic
retry. Popup closure interrupts the queue; an already-injected send may finish.
Keep the popup open and inspect the destination before any manual retry.

## Testing

Run `node --test tests/*.test.cjs` and `node tests/browser-check.cjs`.
The latter runs local fixtures with Chrome's headless CLI, not DevTools Protocol.
Fixtures prove queue/UI behavior and adapter state transitions; they are not
authenticated provider end-to-end tests. No real messages are sent by these tests.

1. Reload **Page capture** at `chrome://extensions`; review any new site-access
   permissions. Keep the popup architecture enabled (there is no Side Panel).
2. Open two disposable ChatGPT conversations in different windows and an empty
   new chat. Capture a nonsensitive page, select those destinations, then Send.
   Confirm PNG plus the unmodified `.txt` attachment in each destination and
   **Sent** in the popup. Test a new chat's URL transition as well.
3. Repeat with an existing draft or existing attachment in one chat. That chat
   must remain untouched and report Failed, while the other selected chat sends.
4. Open Claude and the other listed providers on recognized conversation URLs.
   Refresh: each should appear under its provider, with a disabled checkbox and
   **Unsupported**. Expand the status to read the reason. Search by provider or
   title. Check window and Incognito labels; no sending is attempted to these tabs.
5. A failed/uncertain upload must not trigger another Send. Inspect the real chat
   before manually trying again. Account limits and changed provider UIs can
   require a review even with the updated adapter.

## Enabling another provider (Claude is next for manual verification)

File support alone is not adapter verification. For example,
[Claude's upload documentation](https://support.claude.com/en/articles/8241126-upload-files-to-claude)
and [Gemini's upload documentation](https://support.google.com/gemini/answer/14903178)
describe file uploads, but do not establish stable browser automation selectors.

Before implementing and enabling an adapter, inspect its actual signed-in DOM
using a disposable conversation and nonsensitive sample content. Verify:

- A unique editable composer, scoped attachment controls, and an unambiguous Send.
- Both the PNG and complete text are accepted together; neither is silently lost.
- Existing text and attachments are detectable before modifying anything.
- Upload completion/error indicators are distinguishable from merely selected files.
- An outgoing user turn can be matched to this delivery, including both files.
- Editor replacement, background tabs, new-chat URL transitions, failed uploads,
  user edits during upload, and uncertain confirmation do not cause duplicates.

Add provider-specific fixtures and perform live manual tests before setting
`sending: true` and registering the adapter in `provider-delivery.js`. Do not
change capture or extraction for a provider, and do not enable sending merely
because its selectors match once. Until then discovery remains available but
sending remains disabled, as requested.
