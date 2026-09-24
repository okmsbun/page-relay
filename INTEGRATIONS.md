# Destination integrations

The UI stays in the popup. `content.js`, `page-text.js`, `capture-layout.js`, and
the capture pipeline in `popup.js` have no provider-specific behavior.

Opening the popup automatically starts one capture. `popup-session.js` pins the
active source tab/window once at startup. Neither provider switching nor sending
can start another capture. Closing and reopening starts a fresh session with no
previous screenshot or selections. Capture errors instruct the user to reopen;
there are no Capture, Capture again, or Retry buttons.

Discovered providers appear as single-row, horizontally scrollable tabs (also
accessible with Left/Right/Home/End). Only the active provider's conversations are
shown. Selection and send results live outside the tab view, so Send includes
selected conversations on hidden tabs. Counts indicate hidden selections and
an underline flags providers with failed/review results. Provider icons use
Chrome's known HTTPS favicon on the provider's own domain, with a small local
symbol fallback; no third-party favicon service or extra permission is used.

## Current capability

| Provider | Recognized chat routes | Sending |
| --- | --- | --- |
| ChatGPT | New chats, `/c/…`, custom GPT conversations | Enabled; existing user-confirmed adapter, regression fixtures |
| Claude | `/new`, `/chat/…` | Discovery only: adapter not implemented; signed-in DOM inspection blocked by Chrome's Apple Events setting |
| Gemini | `/app`, `/app/…`, account-prefixed `/u/N/app/…` | Discovery only: adapter not implemented; signed-in DOM inspection blocked by Chrome's Apple Events setting |
| DeepSeek | `chat.deepseek.com/`, `/a/chat/s/…` | Discovery only: image acceptance, full-text delivery and outgoing-turn confirmation unverified |
| Perplexity | `/`, `/search/…` | Discovery only: combined-upload readiness and outgoing-turn confirmation unverified |
| Microsoft Copilot | `/`, `/chats/…` | Discovery only: attachment controls, draft detection and full-context delivery unverified |
| Grok | `/`, `/c/…`, `/chat/…` | Discovery only: both-file readiness and outgoing-turn confirmation unverified |
| Meta AI | `meta.ai` / `www.meta.ai`: `/`, `/new`, `/c/…` | Discovery only: signed-in composer and complete-context attachment support unverified |
| Mistral Vibe Chat | `chat.mistral.ai/chat`, `/chat/…` | Discovery only: current upload readiness, draft protection and outgoing-turn confirmation unverified |
| Poe | `poe.com` / `www.poe.com`: `/`, `/chat/…` | Discovery only: per-bot image/file capabilities and delivery confirmation unverified |

These are limitations of the extension's current implementation and verification,
not proven limitations of the services. **Discovery only** must not be confused
with **Unsupported** (a demonstrated capability mismatch). Only ChatGPT has an
implemented sender. No new provider has been live-verified in this change.

Provider tabs are derived from the latest matching open conversations, never
from the whole registry. Refresh adds new providers, removes closed providers,
and selects a remaining provider if the active one disappears. Selections on
unchanged accessible tabs survive refresh. With no matching chats, the popup
shows **No AI chats open** and Refresh; tabs, destination list, search and Send
are hidden. A discovery API failure shows an error rather than claiming no chats
are open.

### DeepSeek diagnosis

The actual open tab inspected during development was
`https://www.deepseek.com/en/`, not `https://chat.deepseek.com/`. The old registry
and permissions recognized only the chat domain; its chat routes were already
supported for discovery. The website is not a conversation and must not receive
an injected sending script. The registry now classifies the public domains
separately. When one is open, a compact notice links to the chat app without
creating a fake destination/provider tab. Clicking that link is a user action;
the extension never navigates an existing user tab automatically.

Exact host permissions cover all registered discovery hosts, including the
DeepSeek website solely for this diagnostic notice. A test enforces registry /
manifest agreement. Reload the extension to apply newly added host permissions.

### Investigation sources and boundaries

- [DeepSeek's public website](https://www.deepseek.com/en/) links to its separate
  chat app; opening the public website is not opening a conversation.
- [Vibe's file documentation](https://docs.mistral.ai/vibe/work/files-and-canvas)
  documents image/text uploads, but does not verify the browser adapter's draft
  or delivery checks. The old Le Chat host currently opens Vibe Chat.
- [Poe's Embed API](https://creator.poe.com/docs/canvas-apps/poe-embed-api-draft)
  applies to Canvas apps; it is not evidence that an extension can safely post
  into arbitrary existing Poe tabs. Signed-out access to Poe redirects to login.
- Public access to Meta AI did not expose a signed-in composer. Meta/Poe route
  recognition is conservative and fixture-tested, not a live sending claim.

No session cookies, private APIs, profile copies, DevTools Protocol, or bypass of
Chrome's disabled Apple Events JavaScript setting were used to obtain access.

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
   Refresh and switch provider tabs: each should appear with a disabled checkbox and
   **Discovery only**. Expand the status to read the reason. Search by provider or
   title. Check window and Incognito labels; no sending is attempted to these tabs.
5. A failed/uncertain upload must not trigger another Send. Inspect the real chat
   before manually trying again. Account limits and changed provider UIs can
   require a review even with the updated adapter.
6. Open `https://chat.deepseek.com/`, then refresh the popup: DeepSeek should
   appear. Close all its chat tabs and refresh: it should disappear. An open
   `www.deepseek.com/en/` tab instead produces a website notice, not a chat row.
7. Close all recognized AI chats and refresh: only the empty state, Refresh, and
   any website notice remain in the destinations section. Reopen one and refresh
   to confirm the provider tabs/list return without losing the page capture.

Live Claude/Gemini verification was attempted but blocked by Chrome's disabled
**View → Developer → Allow JavaScript from Apple Events** setting. No live
attachment or message was sent, and neither provider was enabled. This is a test
access blocker, not evidence that either service cannot accept the capture.

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
