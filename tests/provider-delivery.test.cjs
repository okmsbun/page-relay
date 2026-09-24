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
      crypto: { randomUUID: () => "test-id" },
      ChatDestinations: { validate: async () => {} },
      chrome: {
        tabs: { query: async () => [{ id: 1 }], update: async () => {} },
        scripting: { executeScript: async () => [{ result }] },
      },
    });
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
    assert.deepEqual(await prepare({ id: 1 }, {}), { prepared: true });
  });
}

function geminiHarness({
  result = { prepared: true },
  injectError,
  switchDuringPreparation = false,
  activationError = false,
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
    crypto: { randomUUID: () => "unique-test-id" },
    ChatDestinations: { validate: async () => {} },
    chrome: {
      tabs: {
        query: async () => [{ id: activeId }],
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
          assert.equal(options.args[0].text, "full text");
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
