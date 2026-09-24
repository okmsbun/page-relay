// Pin the source once, at popup startup. Discovery/sending never reselects it.
// A new popup document creates a fresh session; there is no retry/recapture loop.
const sourceTabAtOpen = chrome.tabs.query({ active: true, currentWindow: true })
  .then(([tab]) => tab ? Object.freeze({ id: tab.id, windowId: tab.windowId }) : null);
void startPopupCapture(sourceTabAtOpen);
