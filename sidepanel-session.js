// The capture source is resolved exactly once, when this panel document opens, and the
// result is kept for the whole session: tab navigation/activation does not reload a global
// Side Panel or replace its capture, selections, or send results.
//
// The panel document is an extension page, never a webpage, so it can never be the source
// of a capture. Source lookup failures are reported as lookup failures - never as a page
// that Chrome protects.
const SOURCE_TAB_KEY = "captureSourceTab";
// Long enough for the panel to load after the toolbar click, short enough that a pin from
// an earlier session cannot hijack a panel opened another way (for example the panel menu).
const SOURCE_PIN_MAX_AGE_MS = 15000;
const SOURCE_LOOKUP_FAILED =
  "The tab to capture could not be identified. Open the Side Panel from the toolbar icon while a regular webpage is active, then try again.";
const extensionOrigin = chrome.runtime.getURL("");
let sessionPinnedAt = null;

function isUsableSource(tab) {
  // Our own documents (including this panel) are not capturable webpages.
  return (
    Number.isInteger(tab?.id) &&
    !String(tab.url ?? "").startsWith(extensionOrigin)
  );
}

async function pinnedSourceTab() {
  const stored = await chrome.storage.session
    .get(SOURCE_TAB_KEY)
    .catch(() => null);
  const pin = stored?.[SOURCE_TAB_KEY];
  if (
    !Number.isInteger(pin?.id) ||
    Date.now() - pin.pinnedAt > SOURCE_PIN_MAX_AGE_MS
  )
    return null;
  sessionPinnedAt = pin.pinnedAt;
  return chrome.tabs.get(pin.id).catch(() => null);
}

async function activeTabInPanelWindow() {
  const window = await chrome.windows.getCurrent().catch(() => null);
  if (!Number.isInteger(window?.id)) return null;
  const [tab] = await chrome.tabs
    .query({ active: true, windowId: window.id })
    .catch(() => []);
  return tab ?? null;
}

async function resolveSourceTab() {
  // The tab Chrome reported on the toolbar click is the tab that was active when this
  // panel was opened; the active tab of the panel's own window is the fallback for panels
  // opened without a toolbar click.
  const pinned = await pinnedSourceTab();
  const tab = isUsableSource(pinned) ? pinned : await activeTabInPanelWindow();
  if (!isUsableSource(tab)) throw new Error(SOURCE_LOOKUP_FAILED);
  // Frozen and reused: no later tab switch can replace the source of this session.
  return Object.freeze({
    id: tab.id,
    windowId: tab.windowId,
    url: tab.url ?? "",
    title: tab.title ?? "",
  });
}

// Clicking the toolbar icon grants activeTab to the current tab. When the Side Panel
// is already open, continue capture seamlessly in-place so any previous capture stays
// preserved until the new capture succeeds (falling back to reload if unavailable).
chrome.runtime.onMessage.addListener((message) => {
  if (message?.type !== "captureSource:pinned") return;
  // Ignore a repin notification belonging to the exact pin this fresh panel just loaded.
  if (message.pinnedAt && message.pinnedAt === sessionPinnedAt) return;
  if (message.pinnedAt) sessionPinnedAt = message.pinnedAt;
  if (typeof handleToolbarRepin === "function") {
    void handleToolbarRepin(message);
    return;
  }
  location.reload();
});

void startPanelCapture(resolveSourceTab());
