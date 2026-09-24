// Pin the source in this panel's window once. Tab navigation/activation does not
// reload a global Side Panel or replace its capture, selections, or send results.
// No onActivated/onUpdated capture handlers and no persistence of private captures to disk.
const sourceTabAtOpen = chrome.windows.getCurrent()
  .then((window) => chrome.tabs.query({ active: true, windowId: window.id }))
  .then(([tab]) => tab ? Object.freeze({ id: tab.id, windowId: tab.windowId }) : null);
void startPopupCapture(sourceTabAtOpen);
