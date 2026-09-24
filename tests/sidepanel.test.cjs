const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const root = path.join(__dirname, "..");
const manifest = JSON.parse(
  fs.readFileSync(path.join(root, "manifest.json"), "utf8"),
);

const EXTENSION_ORIGIN = "chrome-extension://abcdefghijklmnopabcdefghijklmnop/";
const PANEL_URL = `${EXTENSION_ORIGIN}sidepanel.html`;

// Runs service-worker.js against a fake toolbar click.
function runServiceWorker() {
  const listeners = {};
  const pinned = new Map();
  const session = {
    set: async (items) => {
      for (const [key, value] of Object.entries(items)) pinned.set(key, value);
    },
    get: async (key) => (pinned.has(key) ? { [key]: pinned.get(key) } : {}),
  };
  const opened = [];
  const messages = [];
  const context = vm.createContext({
    console,
    chrome: {
      action: {
        onClicked: {
          addListener: (listener) => {
            listeners.click = listener;
          },
        },
      },
      storage: { session },
      runtime: { sendMessage: async (message) => messages.push(message) },
      sidePanel: { open: async (options) => opened.push(options) },
    },
  });
  vm.runInContext(
    fs.readFileSync(
      path.join(root, manifest.background.service_worker),
      "utf8",
    ),
    context,
  );
  return { listeners, session, opened, messages };
}

// Runs sidepanel-session.js the way the panel document does.
async function runPanelSession({ pin, tabs, toggles = {} }) {
  const captures = [];
  const queries = [];
  const listeners = {};
  let reloads = 0;
  const context = vm.createContext({
    location: {
      reload: () => {
        reloads += 1;
      },
    },
    chrome: {
      runtime: {
        getURL: (file) => `${EXTENSION_ORIGIN}${file}`,
        onMessage: {
          addListener: (listener) => {
            listeners.message = listener;
          },
        },
      },
      storage: {
        session: { get: async () => (pin ? { captureSourceTab: pin } : {}) },
      },
      windows: { getCurrent: async () => ({ id: 2 }) },
      tabs: {
        get: async (id) => tabs.find((tab) => tab.id === id) ?? null,
        query: async (options) => {
          queries.push(JSON.parse(JSON.stringify(options)));
          return (
            toggles.visible ?? tabs.filter((tab) => tab.id === toggles.activeId)
          );
        },
      },
    },
    startPopupCapture: async (source) => {
      try {
        captures.push(await source);
      } catch (error) {
        captures.push(error);
      }
    },
  });
  vm.runInContext(
    fs.readFileSync(path.join(root, "sidepanel-session.js"), "utf8"),
    context,
  );
  await new Promise(setImmediate);
  await new Promise(setImmediate);
  return { captures, queries, listeners, reloads: () => reloads };
}

test("native global Side Panel replaces the action popup", () => {
  assert.equal(manifest.action.default_popup, undefined);
  assert.equal(manifest.side_panel.default_path, "sidepanel.html");
  assert.ok(fs.existsSync(path.join(root, manifest.side_panel.default_path)));
});

test("the toolbar click pins the clicked tab before opening the panel", async () => {
  const { listeners, session, opened, messages } = runServiceWorker();
  await listeners.click({
    id: 17,
    windowId: 4,
    url: "https://github.com/org/repo",
  });
  const pin = (await session.get("captureSourceTab")).captureSourceTab;
  assert.equal(pin.id, 17);
  assert.equal(pin.windowId, 4);
  assert.equal(pin.url, "https://github.com/org/repo");
  assert.ok(Number.isFinite(pin.pinnedAt));
  assert.equal(opened.length, 1);
  assert.equal(opened[0].windowId, 4);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, "captureSource:pinned");
});

test("an open panel starts a fresh session for the newly clicked tab only", async () => {
  const { messages, listeners } = runServiceWorker();
  const tabs = [
    { id: 17, windowId: 2, url: "https://github.com/org/repo" },
    { id: 42, windowId: 2, url: "https://apps.admob.com/v2/home" },
  ];
  const session = await runPanelSession({
    pin: { id: 17, windowId: 2, url: tabs[0].url, pinnedAt: Date.now() },
    tabs,
    toggles: { activeId: 42 },
  });
  assert.equal(session.reloads(), 0);
  // The panel ignores unrelated messages and reloads only for its own repin request.
  session.listeners.message({ type: "something:else" });
  assert.equal(session.reloads(), 0);
  await listeners.click(tabs[1]);
  const repin = messages.at(-1);
  assert.equal(repin.type, "captureSource:pinned");
  session.listeners.message(repin);
  assert.equal(session.reloads(), 1);
});

test("a toolbar click without a tab is ignored", async () => {
  const { listeners, opened, messages } = runServiceWorker();
  await listeners.click(undefined);
  assert.equal(opened.length, 0);
  assert.equal(messages.length, 0);
});

test("the panel captures the tab that was active when it was opened", async () => {
  const tabs = [
    { id: 17, windowId: 2, url: "https://github.com/org/repo" },
    { id: 99, windowId: 2, url: "https://chatgpt.com/c/one" },
  ];
  const { captures } = await runPanelSession({
    pin: {
      id: 17,
      windowId: 2,
      url: "https://github.com/org/repo",
      pinnedAt: Date.now(),
    },
    tabs,
    toggles: { activeId: 99 },
  });
  assert.equal(captures.length, 1);
  assert.equal(captures[0].id, 17);
  assert.equal(captures[0].windowId, 2);
  assert.equal(captures[0].url, "https://github.com/org/repo");
  assert.ok(Object.isFrozen(captures[0]));
});

test("tab switching after the capture never replaces or restarts the stored source", async () => {
  const tabs = [
    { id: 17, windowId: 2, url: "https://github.com/org/repo" },
    { id: 99, windowId: 2, url: "https://chatgpt.com/c/one" },
  ];
  const toggles = { activeId: 17 };
  const { captures, queries } = await runPanelSession({
    pin: {
      id: 17,
      windowId: 2,
      url: "https://github.com/org/repo",
      pinnedAt: Date.now(),
    },
    tabs,
    toggles,
  });
  toggles.activeId = 99; // The user switches to an AI tab after the capture.
  toggles.visible = [tabs[1]];
  await new Promise(setImmediate);
  assert.equal(captures.length, 1);
  assert.equal(captures[0].id, 17);
  assert.equal(
    queries.length,
    0,
    "a pinned source is not re-queried on tab switches",
  );
});

test("the panel document is never used as the capture source", async () => {
  const panelTab = { id: 1, windowId: 2, url: PANEL_URL };
  const { captures } = await runPanelSession({
    pin: { id: 1, windowId: 2, url: PANEL_URL, pinnedAt: Date.now() },
    tabs: [panelTab],
    toggles: { visible: [panelTab] },
  });
  assert.equal(captures.length, 1);
  assert.equal(
    captures[0].id,
    undefined,
    "the panel document is never captured",
  );
  assert.match(String(captures[0].message), /could not be identified/);
  assert.doesNotMatch(String(captures[0].message), /protect/i);
});

test("a fresh pin wins, and an expired pin falls back to the active tab", async () => {
  const tabs = [
    { id: 17, windowId: 2, url: "https://github.com/org/repo" },
    { id: 42, windowId: 2, url: "https://apps.admob.com/v2/home" },
  ];
  const fresh = await runPanelSession({
    pin: {
      id: 17,
      windowId: 2,
      url: "https://github.com/org/repo",
      pinnedAt: Date.now(),
    },
    tabs,
    toggles: { activeId: 42 },
  });
  assert.equal(fresh.captures[0].id, 17);
  const expired = await runPanelSession({
    pin: {
      id: 17,
      windowId: 2,
      url: "https://github.com/org/repo",
      pinnedAt: Date.now() - 60000,
    },
    tabs,
    toggles: { activeId: 42 },
  });
  assert.equal(expired.captures[0].id, 42);
  assert.equal(expired.queries.length > 0, true);
});

test("manifest/action icons use supplied correctly sized PNGs and panel uses final branding", () => {
  for (const size of [16, 32, 48, 128, 1024]) {
    const file = `assets/icons/icon-${size}.png`;
    const png = fs.readFileSync(path.join(root, file));
    assert.equal(png.toString("hex", 0, 8), "89504e470d0a1a0a");
    assert.equal(png.readUInt32BE(16), size);
    assert.equal(png.readUInt32BE(20), size);
    if (size !== 1024) {
      assert.equal(manifest.icons[size], file);
      assert.equal(manifest.action.default_icon[size], file);
    }
  }
  const html = fs.readFileSync(
    path.join(root, manifest.side_panel.default_path),
    "utf8",
  );
  assert.match(html, /class="app-icon" src="assets\/icons\/icon-48.png"/);
  assert.match(html, /srcset="[^"]*icon-128.png 2x"/);
  assert.match(html, /rel="icon"[^>]+icon-32.png/);
});
