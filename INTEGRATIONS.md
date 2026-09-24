# Destination integrations

The UI runs in Chrome's native **Side Panel**, not an action popup, standalone
tab, or website overlay. `content.js`, `page-text.js`, `capture-layout.js`, and
the capture pipeline in `popup.js` have no provider-specific behavior.

`manifest.json` declares the global `side_panel.default_path` as `sidepanel.html`
and removes `action.default_popup`. The small service worker sets
`openPanelOnActionClick: true`; it does not create per-tab panels or capture data.
This uses Chrome's [global Side Panel API](https://developer.chrome.com/docs/extensions/reference/api/sidePanel).
Only the `sidePanel` permission was added, with Chrome 116+ required.

Open the panel using the extension toolbar icon to grant `activeTab` and start
one automatic capture. `sidepanel-session.js` pins the active source in the
panel's own window once. The same panel document remains open across tab switches
and navigation; its screenshot, text, selections, Busy and send results remain
in memory. Neither switching browser/provider tabs nor sending recaptures a page.
Keep the source tab active and avoid resizing the panel until capture finishes;
`captureVisibleTab` cannot capture a background tab. After capture, browse freely.
Closing/recreating the panel starts a fresh session; captures are not saved to
disk or restored across browser restarts. There are no recapture buttons.
The existing `popup.js`/`popup.css` filenames are retained for the reused capture
and presentation code, not a popup entry point.

### Icons

The supplied, unmodified `assets/icons/icon-16.png`, `icon-32.png`, `icon-48.png`
and `icon-128.png` are mapped by size in both manifest `icons` and
`action.default_icon`. Chrome uses these for toolbar, extension management and
Side Panel chrome; the 128px asset is also the packaged extension/store icon.
The panel header uses 48px with a 128px high-density source; its document icon is
32px. `icon-1024.png` remains the master source for future export/store artwork,
not an oversized toolbar resource. No Chrome Web Store listing was published or
changed remotely.

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
| Claude | `/new`, `/chat/…` | Enabled; live PNG + TXT send, draft/attachment protection and persisted outgoing turn verified |
| Gemini | `/app`, `/app/…`, account-prefixed `/u/N/app/…` | Enabled; live PNG + TXT send, draft/attachment protection and persisted outgoing turn verified |
| DeepSeek | `chat.deepseek.com/`, `/a/chat/s/…` | Discovery only: composer/file control inspected; full attachment/draft/delivery flow unverified |
| Microsoft Copilot | `/`, `/chats/…` | Discovery only: verification reached account authorization consent |

These are limitations of the extension's current implementation and verification,
not proven limitations of the services. **Discovery only** must not be confused
with **Unsupported** (a demonstrated capability mismatch). ChatGPT, Claude and
Gemini have enabled senders. DeepSeek and Copilot have no sending adapter;
their discovery remains available on recognized chat routes, not login routes.
These five are the entire registry. Other providers and their host permissions
and UI icons have been removed, not merely hidden.

Provider tabs are derived from the latest matching open conversations, never
from the whole registry. Refresh adds new providers, removes closed providers,
and selects a remaining provider if the active one disappears. Selections on
unchanged accessible tabs survive refresh. With no matching chats, the panel
shows **No AI chats open** and Refresh; tabs, destination list, search and Send
are hidden. A discovery API failure shows an error rather than claiming no chats
are open.

### DeepSeek new-chat detection

The previous website warning was based only on the hostname. New-chat candidates
at `chat.deepseek.com/` and root/English/Chinese landing routes on `deepseek.com`
or `www.deepseek.com` now receive a read-only integration probe. A usable visible
editor with DeepSeek's composer placeholder (or the observed multiple-file upload
capability as a locale fallback) produces a destination
titled **New chat — DeepSeek**. The open chat root was inspected live and had
these controls. Existing `/a/chat/s/…` conversations retain URL-based discovery.
Marketing pages without a composer, failed probes and sign-in pages produce no
destination; the blanket website-only warning has been removed.

The isolated `deepseek-discovery.js` probe checks URL and controls, never reads
draft text, attaches files, dispatches events or sends. Inaccessible Incognito,
discarded, frozen and loading new-chat tabs are skipped. Probe failure is not
evidence that a site is inherently unsupported; load/sign in and Refresh.
Composer detection does not enable sending before its full flow is verified.

Exact host permissions cover all registered discovery hosts, including the
DeepSeek public domains for this capability check. A test enforces registry /
manifest agreement. No broad `tabs`, `<all_urls>`, storage or debugger access was added.

### Investigation sources and boundaries

Live inspection on 2026-09-24 used Chrome's Apple Events JavaScript after the user
enabled it. No session cookies, private APIs, profile copies, DevTools Protocol,
or security-setting bypass were used. Account sign-in/authorization and service
terms were not accepted automatically. Gemini's first-use upload dialog was
accepted manually by the user before testing continued.

DeepSeek exposed a composer and file control. That alone does not establish
safe delivery, so its sender remains disabled. Copilot showed account
authorization and later a sign-in portal at `copilot.com`; that portal is not
treated as a verified conversation route. Further signed-in tests and any
required user consent are still needed for DeepSeek and Copilot sending.

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
retry. Panel closure interrupts the queue; an already-injected send may finish.
Keep the panel open and inspect the destination before any manual retry.

### Busy destinations

If an enabled provider's adapter detects an ongoing response before changing the
composer or uploading files, the destination reports **Busy · Generating a
response**, not Failed. No message was submitted by that attempt. Other selected
destinations continue; the busy destination stays selected for an explicit Send
click once generation finishes. Refreshing, waiting, or switching provider tabs
does not submit it automatically. Previously sent destinations remain disabled.

Busy is a structured pre-mutation result, not a guess based on error wording.
Real errors remain Failed; uncertain results after modifying the composer or
attempting submission remain Needs review and cannot be retried in that panel
session. There is no automatic continuation or duplicate Send click.

## Claude and Gemini live verification

Both provider adapters were exercised in separate disposable signed-in chats
with a synthetic blue-square PNG and a TXT file containing a unique sample
marker. No real captured page or personal data was sent. Each provider received
both files and answered with the image contents and text marker. Each adapter
returned `sent: true` only after finding its unique prompt marker and evidence
of both attachments on the outgoing user turn. Those turns and attachments
remained present after reloading the chats.

For each provider, a nonempty test draft was rejected without changing its text
or uploading anything. A separate existing-attachment test was also rejected
without removing that attachment. Only test-created drafts/attachments were
cleaned up. The successful test conversations were left open for inspection.

The live tests executed the same injected adapter functions through Apple Events;
they were not an end-to-end click-through of the packaged extension popup.
Queue dispatch, panel selection, editor replacement, upload errors, edits during
preparation, missing/partial delivery proof, and Gemini tab restoration are
covered separately by local automated fixtures. Real network-failure injection
and every account/locale variant have not been live-tested.

Gemini mounts its upload controls reliably only in an active tab. Its integration
temporarily activates the selected destination within its window, without
focusing another window, then restores the previous tab if the user has not
switched tabs meanwhile. Capture and text extraction do not participate in this
behavior. Its two upload controls receive PNG then TXT; upload consent is never
accepted by the adapter. Gemini may add a suffix to the PNG filename, so delivery
matches its prepared image source and the TXT filename, plus the unique prompt.
Claude matches both attachment filenames on its outgoing user turn.

Both adapters click Send at most once. An upload/edit/error after modifying the
composer, an interrupted injection, or incomplete delivery proof reports
**Needs review**, not Sent, and leaves the draft for inspection. A composer
clearing alone is not success. Existing drafts fail safely before mutation.

## Testing

Run `node --test tests/*.test.cjs` and `node tests/browser-check.cjs`.
The latter runs local fixtures with Chrome's headless CLI, not DevTools Protocol.
Fixtures prove queue/UI behavior and adapter state transitions; they are not
authenticated provider end-to-end tests. No real messages are sent by these tests.

1. Reload **Page capture** at `chrome://extensions`; review the Side Panel
   permission and final extension icon. Pin the extension, open a nonsensitive
   source page, and click the toolbar icon. The UI must open inside Chrome's
   native Side Panel, not a popup or new tab. Keep the source active until capture
   finishes, then switch/navigate tabs: preview, text, selections and results
   should remain unchanged. Resize the panel after capture to check its layout.
2. Open disposable ChatGPT, Claude and Gemini conversations, including an empty
   new chat. Open the panel on a nonsensitive source page, let capture finish,
   select those destinations across provider tabs, then Send.
   Confirm PNG plus the unmodified `.txt` attachment in each destination and
   **Sent** in the panel. Test a new chat's URL transition as well.
3. Repeat with an existing draft or existing attachment in one chat. That chat
   must remain untouched and report Failed, while the other selected chat sends.
4. Open DeepSeek and Copilot on recognized conversation URLs. Refresh and
   switch provider tabs: these should appear with disabled checkboxes and
   **Discovery only**. Expand the status to read the reason. Search by provider or
   title. Check window and Incognito labels; no sending is attempted to these tabs.
5. A failed/uncertain upload must not trigger another Send. Inspect the real chat
   before manually trying again. Account limits and changed provider UIs can
   require a review even with the updated adapter.
6. Open `https://chat.deepseek.com/` with its usable composer, then Refresh:
   **New chat — DeepSeek** should appear. Check an existing conversation too.
   A public landing page is included only when its composer probe succeeds;
   a marketing page alone produces no destination and no website warning.
7. Close all recognized AI chats and refresh: only the compact empty state and
   Refresh remain in the destinations section. Reopen one and refresh
   to confirm the provider tabs/list return without losing the page capture.

8. For Gemini, verify the temporary destination activation returns to the source
   tab. Keep the panel open; if it closes or any result is uncertain, inspect the
   destination before starting another capture/send. An already-injected operation
   can finish after panel closure. Complete any first-use upload consent yourself.

## Enabling another provider

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
