const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
const root = path.join(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

function harness(chrome = {}) {
  const context = vm.createContext({ chrome, URL });
  vm.runInContext(read("ai-providers.js"), context);
  vm.runInContext(read("chat-destinations.js"), context);
  return vm.runInContext("ChatDestinations", context);
}
const tab = (id, windowId = 10, extra = {}) => ({
  id,
  windowId,
  index: id,
  title: "Same title",
  url: `https://chatgpt.com/c/chat-${id}`,
  incognito: false,
  active: false,
  status: "complete",
  ...extra,
});

test("discovery includes background tabs across windows and excludes inaccessible incognito", () => {
  const api = harness();
  const entries = api.describeTabs(
    [
      tab(1),
      tab(2, 20),
      tab(3, 30, { incognito: true }),
      tab(4, 10, { url: "https://chatgpt.com.evil.test/c/foo" }),
      tab(5, 10, { url: "https://example.com" }),
    ],
    10,
    false,
  );
  assert.equal(entries.length, 2);
  assert.match(entries[0].label, /This window.*Tab 2.*Background/);
  assert.match(entries[1].label, /Other window 1.*Tab 3/);
});

test("permitted incognito is labelled and duplicate chat tabs are consolidated", () => {
  const api = harness();
  const entries = api.describeTabs(
    [
      tab(1),
      tab(2, 10, { url: "https://chatgpt.com/c/chat-1" }),
      tab(3, 20, { incognito: true, url: "https://claude.ai/chat/x" }),
    ],
    10,
    true,
  );
  assert.equal(entries.length, 2);
  const duplicate = entries.find((entry) => entry.id === 1);
  assert.match(duplicate.label, /Open in 2 tabs/);
  assert.match(entries.find((entry) => entry.id === 3).label, /Incognito/);
});

test("only providers with a preparation integration are ever listed", () => {
  const api = harness();
  const context = vm.createContext({ URL });
  vm.runInContext(read("ai-providers.js"), context);
  const providers = vm.runInContext("AIProviders", context);
  assert.deepEqual(
    Array.from(providers.all, (provider) => provider.id),
    ["chatgpt", "claude", "gemini"],
  );
  assert.ok(providers.all.every((provider) => provider.preparation === true));
  // Removed providers must not be recognised, listed, or granted their own pattern.
  assert.equal(providers.get("deepseek"), undefined);
  assert.equal(providers.get("copilot"), undefined);
  assert.equal(providers.match("https://chat.deepseek.com/a/chat/s/one"), null);
  assert.equal(providers.match("https://www.deepseek.com/en/"), null);
  assert.equal(
    providers.match("https://copilot.microsoft.com/chats/two"),
    null,
  );
  assert.ok(
    !providers.patterns.some((pattern) => /deepseek|copilot/.test(pattern)),
  );
  assert.ok(!fs.existsSync(path.join(root, "deepseek-discovery.js")));
  const entries = api.describeTabs(
    [
      tab(1),
      tab(2, 10, { url: "https://chat.deepseek.com/a/chat/s/test" }),
      tab(3, 10, { url: "https://copilot.microsoft.com/chats/test" }),
    ],
    10,
    false,
  );
  assert.deepEqual(
    entries.map((entry) => entry.id),
    [1],
  );
  assert.ok(
    !entries.some((entry) => entry.unavailable),
    "no discovery-only entries are exposed",
  );
});

test("favicons accept only HTTPS provider-host assets and otherwise use a local fallback", () => {
  const api = harness();
  const urls = [
    "https://chatgpt.com/favicon.ico",
    "https://tracking.example/icon.png",
    "javascript:alert(1)",
    "http://chatgpt.com/favicon.ico",
  ];
  const entries = api.describeTabs(
    urls.map((favIconUrl, i) =>
      tab(i + 1, 10, { favIconUrl, url: `https://chatgpt.com/c/${i}` }),
    ),
    10,
    false,
  );
  assert.equal(entries[0].favicon, urls[0]);
  assert.ok(entries.slice(1).every((entry) => entry.favicon === null));
});

test("preparation visits every selected destination and reports per-destination results", async () => {
  const api = harness({ tabs: { get: async (id) => tab(id) } });
  const capture = { screenshot: "png", text: "plain text" };
  const calls = [];
  const updates = [];
  const results = await api.prepareSelected(
    api.describeTabs([tab(1), tab(2), tab(3)], 10, false),
    capture,
    async (destination, value) => {
      assert.equal(value, capture);
      calls.push(destination.id);
      if (destination.id === 2) throw new Error("upload failed");
      return { prepared: true };
    },
    (id, result) => updates.push([id, result.state]),
  );
  assert.deepEqual(calls, [1, 2, 3]);
  assert.deepEqual(
    Array.from(results, (result) => result.state),
    ["prepared", "failed", "prepared"],
  );
  assert.equal(updates.length, 6);
});

test("navigation, closed tabs and revoked Incognito access fail before preparation", async () => {
  const api = harness({
    tabs: {
      get: async (id) => {
        if (id === 2) throw new Error("No tab");
        return tab(
          id,
          10,
          id === 1
            ? { url: "https://chatgpt.com/c/replaced" }
            : { incognito: true },
        );
      },
    },
    extension: { isAllowedIncognitoAccess: async () => false },
  });
  const choices = api.describeTabs(
    [tab(1), tab(2), tab(3, 10, { incognito: true })],
    10,
    true,
  );
  let preparations = 0;
  const results = await api.prepareSelected(
    choices,
    {},
    async () => {
      preparations++;
    },
    () => {},
  );
  assert.equal(preparations, 0);
  assert.ok(results.every((result) => result.state === "failed"));
});

test("an uncertain preparation is marked for review, never reported as added", async () => {
  const api = harness({ tabs: { get: async () => tab(1) } });
  const results = await api.prepareSelected(
    api.describeTabs([tab(1)], 10, false),
    {},
    async () => {
      const error = new Error("Composer changed while adding");
      error.needsReview = true;
      throw error;
    },
    () => {},
  );
  assert.deepEqual(
    Array.from(results, (result) => result.state),
    ["review"],
  );
  const unconfirmed = await api.prepareSelected(
    api.describeTabs([tab(1)], 10, false),
    {},
    async () => ({ prepared: false }),
    () => {},
  );
  assert.deepEqual(
    Array.from(unconfirmed, (result) => result.state),
    ["review"],
  );
});

test("a busy chat is reported as retryable and a definite refusal as failed", async () => {
  const api = harness({ tabs: { get: async () => tab(1) } });
  const choices = api.describeTabs([tab(1)], 10, false);
  const busy = await api.prepareSelected(
    choices,
    {},
    async () => {
      const error = new Error("Generating a response");
      error.busy = true;
      error.needsReview = false;
      throw error;
    },
    () => {},
  );
  assert.deepEqual(
    Array.from(busy, (result) => result.state),
    ["busy"],
  );
  const refused = await api.prepareSelected(
    choices,
    {},
    async () => {
      const error = new Error(
        "This chat has an unsent draft. Send or clear it first.",
      );
      error.needsReview = false;
      throw error;
    },
    () => {},
  );
  assert.deepEqual(
    Array.from(refused, (result) => result.state),
    ["failed"],
  );
  assert.match(refused[0].message, /unsent draft/);
});

test("manifest grants source and provider hosts, and declares only preparation providers", () => {
  const manifest = JSON.parse(read("manifest.json"));
  const context = vm.createContext({ URL });
  vm.runInContext(read("ai-providers.js"), context);
  const patterns = vm.runInContext("AIProviders.patterns", context);
  // The Side Panel cannot borrow activeTab from the toolbar click, so the source page
  // needs declared host access; that grant also covers every provider destination.
  assert.ok(manifest.host_permissions.includes("<all_urls>"));
  for (const pattern of patterns) {
    const origin = new URL(pattern.replace(/\*$/, "")).origin;
    assert.ok(
      manifest.host_permissions.includes(pattern) ||
        manifest.host_permissions.includes("<all_urls>"),
      `${origin} must be reachable for preparation`,
    );
  }
  assert.deepEqual(manifest.permissions, [
    "scripting",
    "sidePanel",
    "storage",
    "tabs",
  ]);
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.side_panel.default_path, "sidepanel.html");
  assert.equal(manifest.action.default_popup, undefined);
  // setPanelBehavior({openPanelOnActionClick}) swallows the toolbar click and with it the
  // source tab, so the panel is opened from chrome.action.onClicked instead.
  const serviceWorker = read("service-worker.js");
  assert.ok(!serviceWorker.includes("setPanelBehavior"));
  assert.ok(serviceWorker.includes("chrome.action.onClicked"));
});

test("every listed provider has an adapter that never submits", () => {
  const panel = read("sidepanel.html");
  const providers = vm.runInContext(
    "AIProviders.all",
    (() => {
      const context = vm.createContext({ URL });
      vm.runInContext(read("ai-providers.js"), context);
      return context;
    })(),
  );
  for (const provider of providers) {
    const adapter = `${provider.id}-adapter.js`;
    assert.ok(fs.existsSync(path.join(root, adapter)), `${adapter} must exist`);
    assert.ok(panel.includes(`src="${adapter}"`));
    assert.ok(
      panel.indexOf(`src="${adapter}"`) <
        panel.indexOf('src="provider-delivery.js"'),
    );
    const source = read(adapter);
    assert.doesNotMatch(
      source,
      /send\.click\(\)/,
      `${adapter} must not click a send control`,
    );
    assert.doesNotMatch(
      source,
      /KeyboardEvent|keydown|keypress|keyCode|which:\s*13/i,
      `${adapter} must never synthesize a key event`,
    );
    assert.match(source, /prepared: true/);
  }
  const delivery = read("provider-delivery.js");
  assert.ok(delivery.includes("prepareInChatGPT"));
  assert.ok(delivery.includes("prepareInClaude"));
  assert.ok(delivery.includes("prepareInGemini"));
});
