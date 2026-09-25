# PageRelay integration notes

Developer notes for the destination integrations. See `README.md` for the user
flow and `PRIVACY.md` for data handling.

The UI runs in Chrome's native **Side Panel**, not an action popup, standalone
tab, or website overlay. `content.js`, `page-text.js`, `capture-layout.js`, and
the capture pipeline in `panel.js` have no provider-specific behavior.

`manifest.json` declares the global `side_panel.default_path` as `sidepanel.html`
and removes `action.default_popup`. The service worker opens the panel from
`chrome.action.onClicked`, so Chrome still reports the clicked tab; it does not
create per-tab panels or capture data. This uses Chrome's
[global Side Panel API](https://developer.chrome.com/docs/extensions/reference/api/sidePanel).

Host access is declared for the capturable web (`<all_urls>`): a Side Panel
cannot borrow `activeTab` from the toolbar click, because
`sidePanel.setPanelBehavior({ openPanelOnActionClick: true })` consumes that
click - no action event and no user gesture reaches the extension, and the
automatic capture on a normal HTTPS page fails. The panel is therefore opened
from `chrome.action.onClicked`, which also hands the extension the tab the user
was on. `tabs` identifies that source tab and classifies protected pages;
`activeTab` is not declared because it adds nothing once `<all_urls>` is granted.

Open the panel using the extension toolbar icon to start one automatic capture.
`service-worker.js` pins that clicked tab in `chrome.storage.session`, and
`sidepanel-session.js` resolves the source exactly once when the panel document
opens: the pinned tab when the click is recent, otherwise the active tab of the
panel's own window. The resolved source is frozen and reused, so switching tabs
afterwards never replaces or restarts it. The panel's own `chrome-extension://`
document can never be the source; an unusable lookup is reported as a lookup
failure, never as a page Chrome protects. The same panel document remains open
across tab switches and navigation; its screenshot, text, selections, Busy and
preparation results remain in memory. Keep the source tab active and avoid
resizing the panel until capture finishes; `captureVisibleTab` cannot capture a
background tab. After capture, browse freely. Closing/recreating the panel starts
a fresh session; captures are not saved to disk or restored across browser
restarts. There are no recapture buttons.

### Permissions

| Permission               | Why PageRelay needs it                                                                                                                                                               |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `scripting`              | Injects `page-text.js` and `content.js` into the captured tab to scroll it, measure it and extract its rendered text.                                                                |
| `sidePanel`              | Hosts the PageRelay UI in Chrome's side panel.                                                                                                                                       |
| `storage`                | Keeps the pinned capture source tab in `chrome.storage.session` between the toolbar click and the panel loading. Session storage only; the extension writes nothing to disk.         |
| `tabs`                   | Reads the clicked tab's id/url to pin the capture source, to list AI conversations across windows, and to tell a real protected page from a lookup failure.                          |
| `<all_urls>` host access | The capture engine must scroll and screenshot whatever page the user is on, and preparation must script the chosen AI chat. This is the only way a side panel can reach those pages. |

No debugger, cookie, clipboard, download, or webRequest access is requested.
No analytics, remote endpoints, or PageRelay servers exist.

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
shown. Selection and preparation results live outside the tab view, so Add to chat
includes selected conversations on hidden tabs. Counts indicate hidden selections and
an underline flags providers with failed/review results. Provider icons use
Chrome's known HTTPS favicon on the provider's own domain, with a small local
symbol fallback; no third-party favicon service or extra permission is used.

## Current capability

This extension **prepares** a chat: it attaches the full-page PNG, attaches the
extracted page text with a title/URL header, and preserves existing composer content. It never submits:
no Send click, no Enter/Return, no generation is started. The user reviews the
draft and sends it. "Added" therefore means "the capture is in that chat's draft".

| Provider | Recognized chat routes                          | Composer preparation                                                                                                |
| -------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| ChatGPT  | New chats, `/c/…`, custom GPT conversations     | Enabled; attachment-only preparation and existing-content preservation covered by fixtures |
| Claude   | `/new`, `/chat/…`                               | Enabled; attachment-only preparation and existing-content preservation covered by fixtures    |
| Gemini   | `/app`, `/app/…`, account-prefixed `/u/N/app/…` | Enabled; attachment-only preparation, upload-menu/consent handling and preservation covered by fixtures   |

These three are the entire registry, and every one of them has a complete,
verified preparation integration. A provider appears in the panel only when such
an integration exists; a recognized URL alone is never enough. DeepSeek and
Microsoft Copilot had no preparation adapter (screenshot/text acceptance, draft
protection and confirmation were unverified), so they were removed completely -
registry, panel UI, discovery, provider scripts, host patterns, icons and
documentation. Nothing is shown as "Discovery only".

Host access is declared for the capturable web (`<all_urls>`), because a Side
Panel cannot borrow `activeTab` from the toolbar click. `tabs` is used to identify
the source tab and to classify protected pages.

Provider tabs are derived from the latest matching open conversations, never
from the whole registry. Refresh adds new providers, removes closed providers,
and selects a remaining provider if the active one disappears. Selections on
unchanged accessible tabs survive refresh. With no matching chats, the panel
shows **No AI chats open** and Refresh; tabs, destination list, search and Add
to chat are hidden. A discovery API failure shows an error rather than claiming
no chats are open.

### Investigation sources and boundaries

Live inspection on 2026-09-24 used Chrome's Apple Events JavaScript after the user
enabled it. No session cookies, private APIs, profile copies, DevTools Protocol,
or security-setting bypass were used. Account sign-in/authorization and service
terms were not accepted automatically. Gemini's first-use upload dialog was
accepted manually by the user before testing continued.

Recognition identifies a candidate from Chrome's URL and title, not a guarantee
that the tab is signed in or that preparation works. Unknown routes, shared
read-only pages, and sign-in pages are excluded. New routes require verification
before adding them. No provider without a verified preparation integration is
listed, and none has a guessed adapter.

Host access is declared as `<all_urls>` so the panel can prepare the capture in
any accessible provider chat, and `tabs` is used to name the source tab and to
classify protected pages. There is no debugger, clipboard, or cookie permission.
Incognito destinations require Chrome's **Allow in Incognito** setting and are
explicitly labelled.

`ai-providers.js` owns URL recognition and capability flags;
`chat-destinations.js` owns discovery, selection validation, and independent
results; `provider-delivery.js` dispatches to preparation adapters. Neither
selecting nor refreshing destinations injects a preparation script. Providers
without an integration cannot bypass the capability check by invoking the queue
directly.

## Attachment-only preparation

`capture-preparation.js` builds one stable delivery identity and the same TXT bytes
for each capture, shared by all destinations. The header contains `Page title:`
and `URL:`, an optional technical-limit truncation note, a separator, then the
original extracted text. Internal IDs are used in filenames, never TXT content.
The adapters never focus or edit the message editor and never inspect Send to
decide whether files are prepared.

Before uploading, the injected routine snapshots the editor's exact HTML (or
textarea value) and existing attachment identities, including image sources.
Rendered attachments are retained by the provider's normal upload change handler;
only the new PNG/TXT are assigned to the upload input. Existing files are never
copied into the new batch. A native selection not yet represented by rendered
attachments is rejected before replacing that input's selection. Existing upload
progress is Busy and can be retried manually once finished.

Completion requires one matching new PNG and one matching new TXT, no visible
upload progress/error, unchanged editor content, and preservation of the original
attachment set. The expected count is the initial count plus two, not always two.
Changes by the user or provider during preparation result in Needs review; no
restoration or automatic retry overwrites user work. A provider that replaces
existing attachment state instead of appending is detected and reported for review.
This verification cannot reconstruct files removed internally by a changed provider
UI; the live append checks below are required for current account/UI variants.

ChatGPT uses the current composer form and its upload control, including the
`data-composer-markdown` editor variant. Claude uses its ChatComposer and file
thumbnail tiles. Both receive PNG and TXT in one new upload batch.

Gemini receives PNG, waits for its matching preview, then uploads TXT. It may
rename/re-encode PNG to `<unique-stem>_<suffix>.jpg`; matching accepts that observed
conversion and verifies a decoded image. Existing files are included in preservation
checks. Consent is never accepted automatically. Gemini temporarily activates its
destination tab, restoring the prior tab only if the user has not switched away;
restoration is best effort with a two-second bound.

## Scheduling, timeouts and duplicate protection

ChatGPT and Claude have concurrent lanes; destinations within a lane remain
sequential. Gemini starts after both lanes have returned results and runs sequentially.
Queue results remain in the original selection order; failures are isolated.

The queue reserves a conversation for the actual operation lifetime, including
operations that outlive their 150-second UI timeout. Gemini windows are reserved
as well. Extension-wide Web Locks in the dispatcher prevent other panel documents
from concurrently preparing the same conversation or activating another Gemini
chat in the same window. A blocked operation reports retryable Busy instead of
waiting indefinitely. The injected routine also has a per-tab lock and a deadline.

A pre-preparation timeout is Failed; uncertainty after invoking an adapter is
Needs review. A timed-out injection may still finish, so locks remain until its
actual promise settles, and late results never overwrite the panel's review state.

For the same capture object, the panel remembers completed/review outcomes and
shares pending attempts. Stable filenames and an isolated-world attempt ledger
prevent duplicate uploads inside a tab, including a partial failed attempt. Existing
matching files are checked if that ledger was lost. These are capture-session
protections, not a permanent cross-session content-hash deduplication service.
A new capture is a new operation. Added and Needs review rows stay disabled,
including refresh; Busy/Failed can be retried explicitly.

## Live verification boundary

Earlier live tests verified the former prompt-writing adapters and the observed
provider selectors, including Gemini's JPEG conversion. They do not establish
that this new append-only flow preserves existing content on every signed-in UI.
The current attachment-only/preservation behavior is covered by automated browser
fixtures; perform the manual checks below after reloading the installed extension.
No messages are submitted by the automated tests.

## Testing

Run `node --test tests/*.test.cjs`, `node tests/browser-check.cjs`, and
`node tests/provider-controls.cjs`.
Both browser test runners use isolated headless Chrome with DevTools Protocol.
They wait for actual fixture completion, including async TXT reads; the controls
check delivers native pointer/keyboard input. Neither opens a visible temporary profile.
Fixtures prove queue/UI behavior and adapter state transitions; they are not
authenticated provider end-to-end tests. No real messages are sent by these tests.

1. Reload **PageRelay** at `chrome://extensions`; review the Side Panel
   permissions (`scripting`, `sidePanel`, `storage`, `tabs`), host
   access (`<all_urls>`) and the final extension icon. Pin the extension, then
   check capture-source handling on real pages:
   - a normal HTTPS page (for example GitHub) → toolbar icon → the panel must
     capture the page, not report a protected page;
   - Google AdMob → toolbar icon → capture must work for that page too;
   - `chrome://extensions` → toolbar icon → the protected-page message must still
     appear (this is the only case that may show it);
   - after a successful capture, switch between the source page, an AI tab and
     back: preview, text, selections and results must remain unchanged, and the
     status must never fall back to the protected-page message.
     The UI must open inside Chrome's native Side Panel, not a popup or new tab.
     Keep the source active until capture finishes, then navigate tabs. Resize the
     panel after capture to check its layout.
2. Open disposable ChatGPT, Claude and Gemini conversations, including an empty
   new chat. Open the panel on a nonsensitive source page, let capture finish,
   select those destinations across provider tabs, then click **Add to N chats**.
   Confirm only the PNG and TXT were added, the TXT header has the title/URL,
   the editor stays empty, and **nothing was submitted**: no new user
   turn, no generation. The panel must show **Added**. Test a new chat's URL
   transition as well.
3. Repeat for each provider with existing text, existing attachments, and both.
   Original text and attachments must remain unchanged; only the new PNG/TXT are
   added and the result is Added. Verify TXT metadata and the unchanged extracted
   body, then repeat the Add action to check that no duplicate files appear.
   During another attempt, edit the draft: the result must be Needs review and
   the edit must remain untouched.
4. Only ChatGPT, Claude and Gemini may ever appear. Open a DeepSeek and a
   Microsoft Copilot tab and refresh: neither may appear as a provider tab or a
   destination, and no "Discovery only"/"not implemented" text may be shown.
   Search by provider or title; check window and Incognito labels.
5. A failed or uncertain preparation must not add anything twice. Inspect the
   real chat before trying again. Account limits and changed provider UIs can
   require a review even with the updated adapters.

6. For Gemini, verify the temporary destination activation returns to the source
   tab. Keep the panel open; if it closes or any result is uncertain, inspect the
   destination before acting again. An already-injected preparation can finish
   after panel closure. Complete any first-use upload consent yourself.
7. Close all recognized AI chats and refresh: only the compact empty state and
   Refresh remain in the destinations section. Reopen one and refresh to confirm
   the provider tabs/list return without losing the page capture.

## Adding another provider

File support alone is not adapter verification. For example,
[Claude's upload documentation](https://support.claude.com/en/articles/8241126-upload-files-to-claude)
and [Gemini's upload documentation](https://support.google.com/gemini/answer/14903178)
describe file uploads, but do not establish stable browser automation selectors.

Before implementing and enabling an adapter, inspect its actual signed-in DOM
using a disposable conversation and nonsensitive sample content. Verify:

- A unique editable composer and scoped attachment controls for both files.
- Both the PNG and complete text are accepted together; neither is silently lost.
- Existing text and attachments are detectable before modifying anything.
- Upload completion/error indicators are distinguishable from merely selected files.
- The composer text remains unchanged and both new attachments are ready while
  pre-existing attachments remain present and nothing is submitted.
- Editor replacement, background tabs, new-chat URL transitions, failed uploads,
  and user edits during preparation cannot produce a duplicate or a hidden submit.

Add provider-specific fixtures and perform live manual tests before setting
`preparation: true` and registering the adapter in `provider-delivery.js`. Do not
change capture or extraction for a provider, and do not list a provider merely
because its selectors match once. Nothing is submitted by the extension: an
adapter that cannot prove a prepared draft without submitting one does not
qualify. Until then the provider is not listed at all - no discovery-only rows.
