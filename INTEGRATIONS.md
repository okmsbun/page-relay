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
extracted page text, and inserts the prompt into the composer. It never submits:
no Send click, no Enter/Return, no generation is started. The user reviews the
draft and sends it. "Added" therefore means "the capture is in that chat's draft".

| Provider | Recognized chat routes                          | Composer preparation                                                                                                |
| -------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| ChatGPT  | New chats, `/c/…`, custom GPT conversations     | Enabled; attachment + prompt preparation, draft/attachment protection and uncertainty handling verified by fixtures |
| Claude   | `/new`, `/chat/…`                               | Enabled; live verified attachment + prompt preparation, draft/attachment protection and preparation confirmation    |
| Gemini   | `/app`, `/app/…`, account-prefixed `/u/N/app/…` | Enabled; live verified attachment + prompt preparation, upload-menu/consent handling and preparation confirmation   |

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

## ChatGPT preparation

The adapter re-queries the current editor, normalizes presentation whitespace,
and distinguishes its synchronous insertion from trusted editing events. It
verifies both attachment names in the composer plus the exact prompt before
reporting **Added**. It never clicks Send: there is no submission step, no
outgoing-turn inspection, and no Enter/Return key event anywhere in the code.

Existing drafts and attachments still prevent preparation: the composer is left
exactly as the user wrote it and the destination reports **Failed** with the
reason. Real edits during preparation, missing attachment proof, and any
doubt about the prepared state are **Needs review**, never Added. Review and
Added rows stay disabled for the current capture, including a refresh after a
new-chat URL becomes a conversation URL. There is no automatic retry. Panel
closure interrupts the queue; an already-injected preparation may still finish.
Keep the panel open and inspect the destination before acting again.

### Busy destinations

If an adapter detects an ongoing response before changing the composer or
uploading files, the destination reports **Busy · Generating a response**, not
Failed. Nothing was added by that attempt. Other selected destinations continue;
the busy destination stays selected for an explicit Add click once generation
finishes. Refreshing, waiting, or switching provider tabs never retries it
automatically. Already added destinations remain disabled.

Busy is a structured pre-mutation result, not a guess based on error wording.
Real errors remain Failed; uncertainty after the composer was modified remains
Needs review and cannot be retried in that panel session.

## Claude and Gemini preparation verification

Both adapters were exercised in separate disposable signed-in chats with a
synthetic blue-square PNG and a TXT file containing a unique sample marker. No
real captured page or personal data was used. Each provider received both files
and held the unique prompt in its composer, which is what the extension now
reports as **Added**; nothing was submitted for either provider.

Draft protection was verified per provider: a nonempty test draft was reported as
Failed without changing its text or uploading anything, and an existing
attachment was left untouched. Only test-created drafts/attachments were cleaned
up. The successful test conversations were left open for inspection.

The live tests executed the injected adapter functions through Apple Events; they
were not an end-to-end click-through of the packaged panel. Queue dispatch, panel
selection, editor replacement, upload errors, edits during preparation, and
incomplete attachment evidence are covered by local automated fixtures, as is
the rule that no adapter clicks a send control or dispatches a key event. Real
network-failure injection and every account/locale variant have not been
live-tested.

Gemini mounts its upload controls reliably only in an active tab. Its integration
temporarily activates the selected destination within its window, without
focusing another window, then restores the previous tab if the user has not
switched tabs meanwhile. Capture and text extraction do not participate in this
behavior. Its two upload controls receive PNG then TXT; upload consent is never
accepted by the adapter. Gemini may add a suffix to the PNG filename, so
preparation matches its upload tiles by filename and its composer by prompt.
Claude matches both attachment tiles in its composer.

## Testing

Run `node --test tests/*.test.cjs` and `node tests/browser-check.cjs`.
The latter runs local fixtures with Chrome's headless CLI, not DevTools Protocol.
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
   Confirm the PNG plus the unmodified `.txt` attachment are attached in each
   chat, the prompt is in its composer, and **nothing was submitted**: no new user
   turn, no generation. The panel must show **Added**. Test a new chat's URL
   transition as well.
3. Repeat with an existing draft or an existing attachment in one chat. That chat
   must remain untouched (same text, same attachments) and report Failed, while
   the other selected chats are prepared. Then write your own message in a
   prepared chat and send it manually to confirm the capture is usable.
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
- The composer holds the prompt and both attachments while nothing is submitted.
- Editor replacement, background tabs, new-chat URL transitions, failed uploads,
  and user edits during preparation cannot produce a duplicate or a hidden submit.

Add provider-specific fixtures and perform live manual tests before setting
`preparation: true` and registering the adapter in `provider-delivery.js`. Do not
change capture or extraction for a provider, and do not list a provider merely
because its selectors match once. Nothing is submitted by the extension: an
adapter that cannot prove a prepared draft without submitting one does not
qualify. Until then the provider is not listed at all - no discovery-only rows.
