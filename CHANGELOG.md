# Changelog

All notable changes to **Page Relay** are documented in this file.

## [1.0.0]

First major stable release of Page Relay.

### Capture Workflow & Reliability

- **Recapture:** Added a prominent **Recapture** button in the Side Panel header to return to the pinned source tab and capture it again without closing and reopening the Side Panel, replacing the previous screenshot/text and resetting delivery states.
- **Capture this tab & source indicator:** Added a compact source bar distinguishing the **Captured** source from the **Active tab** with a **Capture this tab** action (never auto-capturing on tab switches).
- **Seamless permission recovery (`Page access required`):** Replaced alarming red error cards on ungranted tabs with a calm **Page access required** state that preserves the previous valid capture and automatically continues capture in-place when you click the Page Relay toolbar icon—fixing global Side Panel context detection (`windowId: -1`) in `chrome.runtime.getContexts`.
- **Restricted & unsupported page UX:** Added a dedicated neutral **Restricted page** / **Unsupported page** state for browser-protected routes (including `chrome://` and account-prefixed Chrome Web Store URLs) with direct recovery when switching to a normal webpage.
- **User interruption handling (`Capture interrupted`):** Added passive manual scroll detection (`wheel`, `keydown`, `touchmove`, scrollbar drag) and reliable detection for tab switches, persistent tab-strip drags, tab closure, and non-hash navigation during capture, presenting a calm **Capture interrupted** state while preserving previous captures.
- **Dynamic page stability & diagnostics:** Improved capture resilience with bounded layout-shift retries, dynamic height-shrink handling, subpixel geometry tolerance, non-layout DOM mutation settle grace, bounded retries for temporary Chrome tab-strip locks, and structured `console.error` diagnostics for genuine unrecovered failures.

### Attachment Delivery & Provider Integrations

- **Immediate attachment delivery feedback:** Reports success immediately upon verified handoff to the selected chat's upload control without waiting for provider-side upload completion, processing, or Send button activation.
- **Independent PNG & TXT delivery:** Tracks screenshot (`.png`) and page text (`.txt`) delivery independently per destination and capture, allowing follow-up TXT-only delivery after adding a screenshot and mixed multi-chat batches with clear status badges (`Screenshot added`, `Page text added`, `Screenshot and text added`) and dynamic action labels.
- **Gemini attachment & menu cleanup:** Resolved dropped PNG attachments during PNG+TXT delivery by yielding briefly for Gemini's async input handoff, updated structural language-independent upload control resolution, excluded mobile camera-only inputs, and ensured Page Relay closes only upload menus it opened that remain open.
- **Default conversation selection:** Automatically selects the first eligible conversation on initial discovery for a capture while respecting manual selection changes across refreshes.

### UI, Quality & Release Engineering

- **Modern Side Panel redesign:** Refreshed visual hierarchy, typography, spacing, light/dark mode tokens, narrow-panel responsiveness (`300px+`), macOS-style page text toggle, segmented provider tabs, and expandable feedback badges.
- **CI & release automation:** Added dependency-free GitHub Actions workflows for code quality (`quality.yml`), automated unit/browser/native-control testing (`test.yml`), and validated Chrome Web Store ZIP packaging (`release.yml`).

## [0.1.3]

- Initial Chrome Web Store Side Panel release with full-page screenshot stitching, rendered page text extraction, draft-preserving attachment preparation for ChatGPT, Claude, and Gemini, and minimal MV3 permissions (`activeTab`, `scripting`, `sidePanel`, `storage`, `tabs`).
