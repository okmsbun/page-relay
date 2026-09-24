// A global panel, not a per-tab panel: Chrome keeps the same UI/session on tab switches.
// The toolbar action also grants activeTab for the automatic source-page capture.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error) => console.error("Could not configure the Side Panel:", error));
