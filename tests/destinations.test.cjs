const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
function harness(chrome = {}, fixtureProviders = []) {
  const context = vm.createContext({ chrome, URL });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../ai-providers.js"), "utf8"), context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../deepseek-discovery.js"), "utf8"), context);
  // Test-only capabilities to exercise future cross-provider dispatch. Never
  // enable an unverified adapter in the extension shipped to the user.
  for (const id of fixtureProviders) vm.runInContext(`AIProviders.get(${JSON.stringify(id)}).sending = true`, context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../chat-destinations.js"), "utf8"), context);
  return vm.runInContext("ChatDestinations", context);
}
const tab = (id, windowId = 10, extra = {}) => ({ id, windowId, index: id, title: "Same title",
  url: `https://chatgpt.com/c/chat-${id}`, incognito: false, active: false, status: "complete", ...extra });

test("discovery includes background tabs across windows and excludes inaccessible incognito", () => {
  const api = harness();
  const entries = api.describeTabs([tab(1), tab(2, 20), tab(3, 30, { incognito: true }),
    tab(4, 10, { url: "https://chatgpt.com.evil.test/c/foo" }), tab(5, 10, { url: "https://example.com" })], 10, false);
  assert.equal(entries.length, 2);
  assert.match(entries[0].label, /This window.*Tab 2.*Background/);
  assert.match(entries[1].label, /Other window 1.*Tab 3/);
});

test("permitted incognito is explicitly labelled and duplicate chat tabs are consolidated", () => {
  const api = harness();
  const entries = api.describeTabs([tab(1), tab(2, 20, { url: tab(1).url }), tab(3, 30, { incognito: true }),
    tab(4, 10, { url: "https://chatgpt.com/" }), tab(5, 20, { url: "https://chatgpt.com/" })], 10, true);
  assert.equal(entries.length, 4);
  assert.match(entries.find((e) => e.id === 1).label, /Open in 2 tabs/);
  assert.match(entries.find((e) => e.id === 3).label, /Incognito/);
  assert.equal(entries.filter((e) => e.url.endsWith("/")).length, 2);
});

test("only conversation/new-chat URLs accepted", () => {
  const { identity } = harness();
  for (const url of ["https://chatgpt.com/c/abc", "https://chatgpt.com/g/g-custom/c/abc", "https://chat.openai.com/", "https://chatgpt.com/?temporary-chat=true"]) assert.ok(identity(url));
  for (const url of ["https://chatgpt.com/auth/login", "https://chatgpt.com/share/abc", "http://chatgpt.com/c/abc", "not a URL"]) assert.equal(identity(url), null);
});

test("discovery queries all accessible windows without broad tabs permission", async () => {
  let query;
  const api = harness({ tabs: { query: async (q) => { query = q; return [tab(1), tab(2, 20)]; } },
    windows: { getCurrent: async () => ({ id: 10 }) }, extension: { isAllowedIncognitoAccess: async () => false } });
  assert.equal((await api.discover()).length, 2);
  assert.equal(query.currentWindow, undefined);
  assert.equal(query.active, undefined);
  assert.equal(query.url.length, 8);
  assert.ok(query.url.includes("https://claude.ai/*"));
});

test("selected destinations receive the same capture; mixed failures never hide successes", async () => {
  const tabs = [tab(1), tab(2, 20), tab(3, 20)];
  const api = harness({ tabs: { get: async (id) => tabs.find((t) => t.id === id) } });
  const choices = api.describeTabs(tabs, 10, false);
  const capture = { screenshot: "png", text: "plain text" };
  const calls = [], updates = [];
  const results = await api.sendSelected(choices.slice(0, 2), capture, async (destination, value) => {
    assert.equal(value, capture); calls.push(destination.id);
    if (destination.id === 2) throw new Error("upload failed");
    return { sent: true };
  }, (id, result) => updates.push([id, result.state]));
  assert.deepEqual(calls, [1, 2]);
  assert.deepEqual(Array.from(results, (r) => r.state), ["sent", "failed"]);
  assert.equal(updates.length, 4);
});

test("navigation, closed tabs and revoked Incognito access fail before delivery", async () => {
  const api = harness({ tabs: { get: async (id) => {
    if (id === 2) throw new Error("No tab");
    return tab(id, 10, id === 1 ? { url: "https://chatgpt.com/c/replaced" } : { incognito: true });
  } }, extension: { isAllowedIncognitoAccess: async () => false } });
  const choices = api.describeTabs([tab(1), tab(2), tab(3, 10, { incognito: true })], 10, true);
  let sends = 0;
  const results = await api.sendSelected(choices, {}, async () => { sends++; }, () => {});
  assert.equal(sends, 0);
  assert.ok(results.every((r) => r.state === "failed"));
});

test("ambiguous submission is marked for review, not reported sent", async () => {
  const api = harness({ tabs: { get: async () => tab(1) } });
  const results = await api.sendSelected(api.describeTabs([tab(1)], 10, false), {}, async () => {
    const error = new Error("Tab closed after submission"); error.needsReview = true; throw error;
  }, () => {});
  assert.equal(results[0].state, "review");
});

test("pre-send busy is temporary, other chats continue, and retry is explicit", async () => {
  const tabs = [tab(1), tab(2), tab(3), tab(4)];
  const api = harness({ tabs: { get: async (id) => tabs.find((item) => item.id === id) } });
  const choices = api.describeTabs(tabs, 10, false);
  const calls = [];
  const results = await api.sendSelected(choices, {}, async (destination) => {
    calls.push(destination.id);
    if (destination.id === 1) throw Object.assign(new Error("Generating a response"), { busy: true, needsReview: false });
    if (destination.id === 3) throw new Error("Upload failed");
    if (destination.id === 4) throw Object.assign(new Error("Uncertain submission"), { busy: true, needsReview: true });
    return { sent: true };
  }, () => {});
  assert.deepEqual(Array.from(results, (result) => result.state), ["busy", "sent", "failed", "review"]);
  assert.deepEqual(calls, [1, 2, 3, 4]); // No automatic retry.
  const retried = await api.sendSelected([choices[0]], {}, async (destination) => {
    calls.push(destination.id); return { sent: true };
  }, () => {});
  assert.equal(retried[0].state, "sent");
  assert.deepEqual(calls, [1, 2, 3, 4, 1]);
});

test("only five providers remain, and unimplemented senders stay discovery-only", () => {
  const api = harness();
  const urls = ["https://chatgpt.com/c/one", "https://claude.ai/chat/two", "https://gemini.google.com/app/three",
    "https://chat.deepseek.com/a/chat/s/four", "https://copilot.microsoft.com/chats/five"];
  const entries = api.describeTabs(urls.map((url, i) => tab(i, 10 + i, { url })), 10, false);
  assert.deepEqual(Array.from(entries, (item) => item.providerId),
    ["chatgpt", "claude", "gemini", "deepseek", "copilot"]);
  assert.equal(entries[0].unavailable, null);
  assert.equal(entries[1].unavailable, null);
  assert.equal(entries[2].unavailable, null);
  assert.ok(entries.slice(3).every((item) => item.discoveryOnly && item.unavailable));
});

test("provider login, share, marketing pages and spoofed domains are excluded", () => {
  const { identity } = harness();
  for (const url of ["https://claude.ai/login", "https://claude.ai/share/one", "https://gemini.google.com/share/two",
    "https://grok.com/share/three", "https://www.perplexity.ai/hub", "https://copilot.microsoft.com/settings",
    "https://claude.ai.evil.test/chat/a", "https://claude.ai:123/chat/a", "https://someone@claude.ai/chat/a"]) {
    assert.equal(identity(url), null, url);
  }
  assert.ok(identity("https://gemini.google.com/u/1/app/one"));
  assert.ok(identity("https://claude.ai/new"));
});

test("discovery-only destinations cannot reach an adapter; later selected chats still send", async () => {
  const tabs = [tab(1, 10, { url: "https://chat.deepseek.com/a/chat/s/test" }), tab(2)];
  const api = harness({ tabs: { get: async (id) => tabs.find((item) => item.id === id) } });
  const calls = [];
  const results = await api.sendSelected(api.describeTabs(tabs, 10, false), {}, async (destination) => {
    calls.push(destination.id); return { sent: true };
  }, () => {});
  assert.deepEqual(calls, [2]);
  assert.deepEqual(Array.from(results, (result) => result.state), ["unavailable", "sent"]);
});

test("DeepSeek roots need a verified composer; existing conversations keep URL discovery", async () => {
  const probes = [];
  const api = harness({ tabs: { query: async () => [tab(1, 10, { url: "https://www.deepseek.com/en/" }),
    tab(2, 10, { url: "https://chat.deepseek.com/" }), tab(3, 20, { url: "https://chat.deepseek.com/a/chat/s/abc" })] },
    scripting: { executeScript: async (options) => { probes.push(options); return [{ result: options.target.tabId === 2 }]; } },
    windows: { getCurrent: async () => ({ id: 10 }) }, extension: { isAllowedIncognitoAccess: async () => false } });
  const { destinations } = await api.discoverOverview();
  assert.equal(destinations.length, 2);
  assert.ok(destinations.every((item) => item.providerId === "deepseek"));
  assert.equal(destinations[0].title, "New chat — DeepSeek");
  assert.equal(destinations[1].conversation, true);
  assert.deepEqual(probes.map((options) => options.target.tabId), [1, 2]);
  assert.ok(probes.every((options) => options.target.frameIds[0] === 0 && options.func.name === "hasDeepSeekComposer"));
});

test("removed providers, read-only shares, account pages and spoofed hosts are excluded", () => {
  const { identity } = harness();
  for (const url of ["https://www.meta.ai/share/a", "https://www.meta.ai/login", "https://poe.com/login?redirect_url=/",
    "https://poe.com/s/shared", "https://poe.com/settings", "https://poe.com.evil.test/chat/x", "https://www.deepseek.com/blog",
    "https://www.perplexity.ai/", "https://grok.com/", "https://www.meta.ai/", "https://chat.mistral.ai/chat", "https://poe.com/",
    "https://chat.deepseek.com/sign_in", "https://chat.deepseek.com/share/a", "https://chat.deepseek.com.evil.test/", "http://deepseek.com/"]) {
    assert.equal(identity(url), null, url);
  }
});

test("DeepSeek public landing with composer is a destination, but denied or inaccessible probes are not", async () => {
  const urls = ["https://www.deepseek.com/en/", "https://deepseek.com/", "https://chat.deepseek.com/",
    "https://www.deepseek.com/", "https://chat.deepseek.com/"];
  const probes = [];
  const api = harness({ tabs: { query: async () => urls.map((url, i) => tab(i + 1, 10, {
    url, incognito: i === 3, discarded: i === 4,
  })) }, scripting: { executeScript: async ({ target }) => {
    probes.push(target.tabId);
    if (target.tabId === 2) throw new Error("Permission denied");
    return [{ result: target.tabId === 1 }];
  } }, windows: { getCurrent: async () => ({ id: 10 }) }, extension: { isAllowedIncognitoAccess: async () => false } });
  const { destinations } = await api.discoverOverview();
  assert.deepEqual(probes, [1, 2, 3]);
  assert.equal(destinations.length, 1);
  assert.equal(destinations[0].title, "New chat — DeepSeek");
  assert.equal(destinations[0].url, "https://www.deepseek.com/en");
  assert.ok(destinations[0].discoveryOnly); // Composer discovery never enables an unverified sender.
});

test("manifest limits host access to the provider registry and preserves MV3 permissions", () => {
  const context = vm.createContext({ URL });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../ai-providers.js"), "utf8"), context);
  const patterns = vm.runInContext("AIProviders.patterns", context);
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "../manifest.json"), "utf8"));
  assert.deepEqual(manifest.host_permissions.sort(), Array.from(patterns).sort());
  assert.deepEqual(manifest.permissions, ["activeTab", "scripting", "sidePanel"]);
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.side_panel.default_path, "sidepanel.html");
  assert.equal(manifest.action.default_popup, undefined);
});

test("favicons accept only HTTPS provider-host assets and otherwise use a local fallback", () => {
  const api = harness();
  const urls = ["https://chatgpt.com/favicon.ico", "https://tracking.example/icon.png", "javascript:alert(1)", "http://chatgpt.com/favicon.ico"];
  const entries = api.describeTabs(urls.map((favIconUrl, i) => tab(i, 10, { favIconUrl })), 10, false);
  assert.equal(entries[0].favicon, urls[0]);
  assert.ok(entries.slice(1).every((entry) => entry.favicon === null));
});

test("cross-provider queue isolates failures and uncertainty without retrying or changing payload", async () => {
  const tabs = [tab(1), tab(2, 20, { url: "https://claude.ai/chat/two" }),
    tab(3, 30, { url: "https://gemini.google.com/app/three" }), tab(4)];
  const api = harness({ tabs: { get: async (id) => tabs.find((item) => item.id === id) } }, ["claude", "gemini"]);
  const capture = Object.freeze({ screenshot: "same PNG", text: "same text" });
  const calls = [];
  const results = await api.sendSelected(api.describeTabs(tabs, 10, false), capture, async (destination, value) => {
    assert.equal(value, capture);
    calls.push(destination.providerId);
    if (destination.providerId === "claude") throw new Error("Existing draft");
    if (destination.providerId === "gemini") { const error = new Error("Unconfirmed"); error.needsReview = true; throw error; }
    return { sent: true };
  }, () => {});
  assert.deepEqual(calls, ["chatgpt", "chatgpt", "claude", "gemini"]);
  assert.deepEqual(Array.from(results, (item) => item.state), ["sent", "sent", "failed", "review"]);
});
