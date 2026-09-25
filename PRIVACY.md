# PageRelay privacy

PageRelay is a local Chrome extension with no backend. It captures a page in your
browser, keeps the result in memory, and prepares it in the AI chats you choose.
This document describes what the code actually does.

## What PageRelay accesses, and why

| Data                                                                            | Why it is accessed                                                                                                             |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| The pixels of the active tab (via `chrome.tabs.captureVisibleTab`)              | To build the full-page screenshot you asked for.                                                                               |
| The rendered text of that page (via an injected script reading the DOM)         | To produce the extracted page text, including rows that only appear while scrolling.                                           |
| The page's title and URL                                                        | They label the capture and are written into the TXT attachment header.                                              |
| The id, window, index, title, URL and Chrome-provided favicon of your open tabs | To list which AI conversations are open (including background tabs and other windows), and to identify the capture source tab. |
| The chosen chat's composer, upload controls and draft state                     | To add only the new files and verify existing draft text and attachments remain unchanged.              |

## Where the data is processed

Everything happens locally, inside your browser:

- Scrolling, measuring and text extraction run as an injected script in the page
  you are capturing.
- Screenshot stitching (canvas), text display, token estimate and character count
  run in the PageRelay side panel document.
- No captured content is sent to PageRelay or to any third party while capturing.

The extension makes no network requests of its own: there is no `fetch`,
`XMLHttpRequest`, `WebSocket`, `sendBeacon`, remote code loading, or any
PageRelay server. There is no analytics, telemetry, tracking, or advertising
code.

## When content leaves your device

Only when you explicitly click **Add to N chats**, and only for the conversations
you selected:

- PageRelay places the PNG screenshot, a `.txt` file with the extracted page
  text and metadata header into that chat's composer, through the signed-in page
  you already have open. This is the same mechanism as attaching files yourself.
- The receiving service (OpenAI, Anthropic or Google) then handles that content
  under its own privacy policy, exactly as it would for any file you attach.
- PageRelay does not submit anything. The message is sent only when _you_ press
  Send in that chat. File contents can already be uploaded to the provider during
  preparation, before you send the message.

If you never select a destination, the captured screenshot and text never leave
your browser and are discarded when the panel closes.

## What is stored, and for how long

- Captured screenshots, extracted text, selections and preparation results live
  in the side panel document's memory. Closing the panel, or restarting the
  browser, discards them.
- Each destination tab retains operation IDs/results in isolated-world memory to
  prevent repeated or partial uploads; these disappear when that document unloads.
- `chrome.storage.session` is used for one small record: the id, window id and
  URL of the tab you clicked the PageRelay icon on, plus a timestamp, so the panel
  knows which page to capture. This is session-only storage; it is not written to
  disk by the extension and it is discarded when the browser session ends.
- The extension does not use `chrome.storage.local`, `chrome.storage.sync`,
  cookies, the clipboard, downloads, or the debugger, and it writes no files.
- Incognito tabs are only used if you enable "Allow in Incognito" for PageRelay;
  even then nothing is persisted.

## Permissions and why they are required

| Permission               | Reason                                                                                                                                                                                        |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scripting`              | Inject the capture/text scripts into the tab being captured.                                                                                                                                  |
| `sidePanel`              | Show the PageRelay interface in Chrome's side panel.                                                                                                                                          |
| `storage`                | Keep the pinned capture source tab in session storage between the toolbar click and the panel loading.                                                                                        |
| `tabs`                   | Identify the capture source tab and list open AI conversations across windows; also distinguishes a genuinely protected page from a failed lookup.                                            |
| `<all_urls>` host access | The capture engine must scroll and screenshot whatever page you are on, and preparation must script the AI chat you select. A side panel cannot get this access from the toolbar click alone. |

## Not done by PageRelay

- No account, sign-in, or PageRelay cloud service.
- No background collection, history scanning, or reading of page data you did not
  ask to capture.
- No automatic sending, no simulated Enter/Return, no starting of AI generation.
- No remote code: all scripts are packaged in the extension.

## Questions

If you find behaviour that contradicts this document, please open an issue in the
repository - the code is the source of truth and this file will be corrected.
