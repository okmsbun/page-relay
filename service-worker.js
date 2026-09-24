// A global panel, not a per-tab panel: Chrome keeps the same UI/session on tab switches.
//
// The toolbar click is the only moment Chrome tells the extension which tab the user was
// on, so that tab is pinned here for the panel to read back. `openPanelOnActionClick` is
// deliberately not used: Chrome consumes that click for the panel, so neither an action
// event nor a user gesture reaches the extension. That is what broke source capture after
// the Side Panel migration - the panel had no grant and no reliable source tab.
const SOURCE_TAB_KEY = "captureSourceTab";
const REPIN_MESSAGE = "captureSource:pinned";

chrome.action.onClicked.addListener((tab) => openPanelForSourceTab(tab));

async function openPanelForSourceTab(tab) {
  if (!Number.isInteger(tab?.id)) return;
  // Only the identity of the clicked tab is stored, and only for this open gesture: a
  // later tab switch must not replace the source of the running capture session.
  const stored = chrome.storage.session
    .set({
      [SOURCE_TAB_KEY]: {
        id: tab.id,
        windowId: tab.windowId,
        url: tab.url ?? "",
        pinnedAt: Date.now(),
      },
    })
    .catch((error) =>
      console.error("Could not pin the capture source:", error),
    );
  try {
    // Opened before any awaited work so the click's user gesture still applies.
    await chrome.sidePanel.open({ windowId: tab.windowId });
    // An open panel is not reloaded by Chrome, so ask it to start a session for this
    // newly clicked tab. A closed panel never receives this and reads the pin itself.
    await chrome.runtime.sendMessage({ type: REPIN_MESSAGE });
  } catch (error) {
    console.error("Could not open the Side Panel:", error);
  }
  await stored;
}
