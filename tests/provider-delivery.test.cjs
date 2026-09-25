const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
const root = path.join(__dirname, "..");

for (const [provider, functionName] of [
  ["chatgpt", "prepareInChatGPT"],
  ["claude", "prepareInClaude"],
  ["gemini", "prepareInGemini"],
]) {
  test(`${provider} propagates only explicit pre-mutation busy results as retryable`, async () => {
    let result;
    const context = vm.createContext({
      setTimeout, clearTimeout,
      crypto: { randomUUID: () => "test-id" },
      ChatDestinations: { validate: async () => {} },
      chrome: {
        tabs: { query: async () => [{ id: 1 }], update: async () => {} },
        scripting: { executeScript: async () => [{ result }] },
      },
    });
    vm.runInContext(fs.readFileSync(path.join(root, "capture-preparation.js"), "utf8"), context);
    vm.runInContext(
      fs.readFileSync(path.join(root, `${provider}-adapter.js`), "utf8"),
      context,
    );
    const prepare = vm.runInContext(functionName, context);
    result = {
      prepared: false,
      busy: true,
      needsReview: false,
      error: "Generating a response",
    };
    await assert.rejects(
      prepare({ id: 1 }, {}),
      (error) => error.busy && !error.needsReview,
    );
    result = {
      prepared: false,
      busy: true,
      needsReview: true,
      error: "Unconfirmed",
    };
    await assert.rejects(
      prepare({ id: 1 }, {}),
      (error) => !error.busy && error.needsReview,
    );
    result = { prepared: false, busy: true, error: "Missing safety evidence" };
    await assert.rejects(
      prepare({ id: 1 }, {}),
      (error) => !error.busy && error.needsReview,
    );
    result = { prepared: false, needsReview: false, error: "Actual error" };
    await assert.rejects(
      prepare({ id: 1 }, {}),
      (error) => !error.busy && !error.needsReview,
    );
    result = { prepared: true };
    assert.equal((await prepare({ id: 1 }, {})).prepared, true);
  });
}

function geminiHarness({
  result = { prepared: true },
  injectError,
  switchDuringPreparation = false,
  activationError = false,
  stalledRestore = false,
} = {}) {
  let activeId = 1;
  const calls = [];
  const destination = {
    id: 2,
    windowId: 5,
    url: "https://gemini.google.com/app/chat",
    providerId: "gemini",
  };
  const context = vm.createContext({
    setTimeout: (fn, ms) => setTimeout(fn, stalledRestore ? 10 : ms), clearTimeout,
    crypto: { randomUUID: () => "unique-test-id" },
    ChatDestinations: { validate: async () => {} },
    chrome: {
      tabs: {
        query: async () => stalledRestore && activeId === 2 ? new Promise(() => {}) : [{ id: activeId }],
        update: async (id, options) => {
          if (activationError) throw new Error("Tab closed");
          assert.equal(options.active, true);
          calls.push(id);
          activeId = id;
        },
      },
      scripting: {
        executeScript: async (options) => {
          assert.equal(options.target.tabId, 2);
          assert.equal(options.args[0].text, "Page title: Untitled page\nURL: \n\n---\n\nfull text");
          assert.equal(
            options.args[0].screenshot,
            "data:image/png;base64,test",
          );
          if (switchDuringPreparation) activeId = 9;
          if (injectError) throw new Error("Execution interrupted");
          return [{ result }];
        },
      },
    },
  });
  vm.runInContext(fs.readFileSync(path.join(root, "capture-preparation.js"), "utf8"), context);
  vm.runInContext(
    fs.readFileSync(path.join(root, "gemini-adapter.js"), "utf8"),
    context,
  );
  const prepare = vm.runInContext("prepareInGemini", context);
  return {
    calls,
    run: () =>
      prepare(destination, {
        screenshot: "data:image/png;base64,test",
        text: "full text",
      }),
  };
}

test("Gemini activates only the selected tab then restores the previous tab after success", async () => {
  const fixture = geminiHarness();
  assert.equal((await fixture.run()).prepared, true);
  assert.deepEqual(fixture.calls, [2, 1]);
});
test("Gemini returns confirmed preparation even if tab restoration never resolves", async () => {
  const fixture = geminiHarness({ stalledRestore: true });
  assert.equal((await fixture.run()).prepared, true);
  assert.deepEqual(fixture.calls, [2]);
});
test("Gemini restores activation after a protected draft rejection without marking it uncertain", async () => {
  const fixture = geminiHarness({
    result: { prepared: false, needsReview: false, error: "Existing draft" },
  });
  await assert.rejects(
    fixture.run(),
    (error) => error.message === "Existing draft" && !error.needsReview,
  );
  assert.deepEqual(fixture.calls, [2, 1]);
});
test("Gemini does not override a user's tab switch while preparing", async () => {
  const fixture = geminiHarness({ switchDuringPreparation: true });
  await fixture.run();
  assert.deepEqual(fixture.calls, [2]);
});
test("Gemini interrupted injection requires review and still restores activation", async () => {
  const fixture = geminiHarness({ injectError: true });
  await assert.rejects(fixture.run(), (error) => error.needsReview === true);
  assert.deepEqual(fixture.calls, [2, 1]);
});
test("Gemini activation failure before injection is a definite failure, not needs-review", async () => {
  const fixture = geminiHarness({ activationError: true });
  await assert.rejects(
    fixture.run(),
    (error) => error.message === "Tab closed" && error.needsReview === false,
  );
  assert.deepEqual(fixture.calls, []);
});

test("enabled provider dispatch and Side Panel scripts agree; unsupported providers cannot prepare", async () => {
  const calls = [];
  const context = vm.createContext({
    URL,
    navigator: { locks: { request: async (_name, _options, action) => action({}) } },
    prepareInChatGPT: async () => {
      calls.push("chatgpt");
      return { prepared: true };
    },
    prepareInClaude: async () => {
      calls.push("claude");
      return { prepared: true };
    },
    prepareInGemini: async () => {
      calls.push("gemini");
      return { prepared: true };
    },
  });
  for (const file of ["ai-providers.js", "provider-delivery.js"]) {
    vm.runInContext(fs.readFileSync(path.join(root, file), "utf8"), context);
  }
  const panel = fs.readFileSync(path.join(root, "sidepanel.html"), "utf8");
  const providers = vm.runInContext("AIProviders.all", context);
  const prepare = vm.runInContext("prepareInDestination", context);
  for (const provider of providers) {
    assert.ok(panel.includes(`src="${provider.id}-adapter.js"`));
    assert.ok(
      panel.indexOf(`src="${provider.id}-adapter.js"`) <
        panel.indexOf('src="provider-delivery.js"'),
    );
    assert.equal(
      (await prepare({ providerId: provider.id }, {})).prepared,
      true,
    );
  }
  for (const removed of [
    { providerId: "deepseek" },
    { providerId: "copilot" },
  ]) {
    await assert.rejects(
      prepare(removed, {}),
      (error) => error.unavailable === true,
    );
  }
  assert.deepEqual(calls, ["chatgpt", "claude", "gemini"]);
});

test("no adapter can submit: no send click, no key events, no submit API", () => {
  for (const file of [
    "capture-preparation.js",
    "chatgpt-adapter.js",
    "claude-adapter.js",
    "gemini-adapter.js",
  ]) {
    const source = fs.readFileSync(path.join(root, file), "utf8");
    assert.doesNotMatch(source, /send\.click\(\)/);
    assert.doesNotMatch(source, /requestSubmit|\.submit\(\)|form\.submit/);
    assert.doesNotMatch(
      source,
      /KeyboardEvent|keydown|keypress|keyup|keyCode|which:\s*13/i,
    );
    assert.doesNotMatch(source, /dispatchEvent\(\s*new\s+KeyboardEvent/);
  }
  const panel = fs.readFileSync(path.join(root, "sidepanel.html"), "utf8");
  assert.match(panel, /Add to chat/);
  assert.doesNotMatch(panel, /Send to</);
});

test("all adapters inject identical metadata TXT bytes and stable filenames for one capture, never a prompt", async () => {
  let serial = 0;
  const received = [];
  const context = vm.createContext({
    Date, setTimeout, clearTimeout,
    crypto: { randomUUID: () => `capture-${++serial}` },
    ChatDestinations: { validate: async () => {} },
    chrome: { tabs: { query: async () => [{ id: 1 }], update: async () => {} },
      scripting: { executeScript: async ({ func, args }) => {
        assert.equal(func.name, "prepareFilesInComposer");
        received.push(args[0]); return [{ result: { prepared: true } }];
      } } },
  });
  for (const name of ["capture-preparation", "chatgpt-adapter", "claude-adapter", "gemini-adapter"])
    vm.runInContext(fs.readFileSync(path.join(root, name + ".js"), "utf8"), context);
  const capture = { title: "Source title", url: "https://example.com/source", screenshot: "data:image/png;base64,test", text: "Original\n\n  whitespace\n", truncated: true };
  for (const name of ["prepareInChatGPT", "prepareInClaude", "prepareInGemini", "prepareInChatGPT"])
    await vm.runInContext(name, context)({ id: 1, url: "destination" }, capture);
  assert.equal(serial, 1);
  for (const payload of received) {
    assert.equal(payload.text, "Page title: Source title\nURL: https://example.com/source\nNote: Extracted page text was truncated because it reached a technical capture limit.\n\n---\n\n" + capture.text);
    assert.equal(payload.png, received[0].png);
    assert.equal(payload.txt, received[0].txt);
    assert.equal(payload.screenshot, capture.screenshot);
    assert.equal(payload.prompt, undefined);
    assert.ok(!payload.text.includes(payload.deliveryId));
  }
  await vm.runInContext("prepareInChatGPT", context)({ id: 1 }, { ...capture, truncated: false });
  assert.equal(serial, 2);
  assert.doesNotMatch(received.at(-1).text, /truncated/);
});

test("shared injected routine contains no editor mutations, focus changes, submission or key simulation", () => {
  const source = fs.readFileSync(path.join(root, "capture-preparation.js"), "utf8");
  assert.doesNotMatch(source, /execCommand|\.focus\(|requestSubmit|\.submit\(|KeyboardEvent|\.innerHTML\s*=|\.textContent\s*=|\.value\s*=/);
  assert.doesNotMatch(source, /payload\.prompt|send\.click\(/);
});

test("extension-wide locks prevent competing panel operations on a conversation and Gemini window", async () => {
  const held = new Set();
  const locks = { request: async (name, options, action) => {
    assert.equal(options.ifAvailable, true);
    if (held.has(name)) return action(null);
    held.add(name);
    try { return await action({ name }); } finally { held.delete(name); }
  } };
  let finish;
  const pending = new Promise((resolve) => { finish = resolve; });
  const calls = [];
  function panel() {
    const context = vm.createContext({ URL, navigator: { locks },
      prepareInChatGPT: async (destination) => { calls.push(destination.id); return pending; },
      prepareInClaude: async () => ({ prepared: true }),
      prepareInGemini: async (destination) => { calls.push(destination.id); return pending; },
    });
    for (const file of ["ai-providers.js", "provider-delivery.js"])
      vm.runInContext(fs.readFileSync(path.join(root, file), "utf8"), context);
    return vm.runInContext("prepareInDestination", context);
  }
  const firstPanel = panel(), secondPanel = panel();
  const chat = { id: 1, url: "https://chatgpt.com/c/same", providerId: "chatgpt", windowId: 1 };
  const first = firstPanel(chat, {});
  await assert.rejects(secondPanel({ ...chat, id: 2, windowId: 2 }, {}), (error) => error.busy && error.needsReview === false);
  const gemini = { id: 3, url: "https://gemini.google.com/app/one", providerId: "gemini", windowId: 1 };
  const third = firstPanel(gemini, {});
  await assert.rejects(secondPanel({ ...gemini, id: 4, url: "https://gemini.google.com/app/two" }, {}), (error) => error.busy && !error.needsReview);
  assert.deepEqual(calls, [1, 3]);
  finish({ prepared: true });
  await Promise.all([first, third]);
  assert.equal(held.size, 0);
});
