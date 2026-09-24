const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

for (const [provider, functionName] of [["chatgpt", "deliverToChatGPT"], ["claude", "deliverToClaude"], ["gemini", "deliverToGemini"]]) {
  test(`${provider} propagates only explicit pre-mutation busy results as retryable`, async () => {
    let result;
    const context = vm.createContext({ crypto: { randomUUID: () => "test-id" },
      ChatDestinations: { validate: async () => {} },
      chrome: { tabs: { query: async () => [{ id: 1 }] },
        scripting: { executeScript: async () => [{ result }] } },
    });
    vm.runInContext(fs.readFileSync(path.join(__dirname, `../${provider}-adapter.js`), "utf8"), context);
    const deliver = vm.runInContext(functionName, context);
    result = { sent: false, busy: true, needsReview: false, error: "Generating a response" };
    await assert.rejects(deliver({ id: 1 }, {}), (error) => error.busy && !error.needsReview);
    result = { sent: false, busy: true, needsReview: true, error: "Unconfirmed" };
    await assert.rejects(deliver({ id: 1 }, {}), (error) => !error.busy && error.needsReview);
    result = { sent: false, busy: true, error: "Missing safety evidence" };
    await assert.rejects(deliver({ id: 1 }, {}), (error) => !error.busy && error.needsReview);
    result = { sent: false, needsReview: false, error: "Actual error" };
    await assert.rejects(deliver({ id: 1 }, {}), (error) => !error.busy && !error.needsReview);
  });
}

function geminiHarness({ result = { sent: true }, injectError, switchDuringSend = false, activationError = false } = {}) {
  let activeId = 1;
  const calls = [];
  const destination = { id: 2, windowId: 5, url: "https://gemini.google.com/app/chat", providerId: "gemini" };
  const context = vm.createContext({ crypto: { randomUUID: () => "unique-test-id" }, ChatDestinations: { validate: async () => {} },
    chrome: { tabs: {
      query: async () => [{ id: activeId }],
      update: async (id, options) => { if (activationError) throw new Error("Tab closed"); assert.equal(options.active, true); calls.push(id); activeId = id; },
    }, scripting: { executeScript: async (options) => {
      assert.equal(options.target.tabId, 2);
      assert.equal(options.args[0].text, "full text");
      assert.equal(options.args[0].screenshot, "data:image/png;base64,test");
      if (switchDuringSend) activeId = 9;
      if (injectError) throw new Error("Execution interrupted");
      return [{ result }];
    } } },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../gemini-adapter.js"), "utf8"), context);
  const deliver = vm.runInContext("deliverToGemini", context);
  return { calls, run: () => deliver(destination, { screenshot: "data:image/png;base64,test", text: "full text" }) };
}

test("Gemini activates only the selected tab then restores the previous tab after success", async () => {
  const fixture = geminiHarness();
  assert.equal((await fixture.run()).sent, true);
  assert.deepEqual(fixture.calls, [2, 1]);
});
test("Gemini restores activation after a protected draft rejection without marking it uncertain", async () => {
  const fixture = geminiHarness({ result: { sent: false, needsReview: false, error: "Existing draft" } });
  await assert.rejects(fixture.run(), (error) => error.message === "Existing draft" && !error.needsReview);
  assert.deepEqual(fixture.calls, [2, 1]);
});
test("Gemini does not override a user's tab switch while sending", async () => {
  const fixture = geminiHarness({ switchDuringSend: true });
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
  await assert.rejects(fixture.run(), (error) => error.message === "Tab closed" && error.needsReview === false);
  assert.deepEqual(fixture.calls, []);
});

test("enabled provider dispatch and popup scripts agree; discovery-only providers cannot send", async () => {
  const calls = [];
  const context = vm.createContext({ URL,
    deliverToChatGPT: async () => { calls.push("chatgpt"); return { sent: true }; },
    deliverToClaude: async () => { calls.push("claude"); return { sent: true }; },
    deliverToGemini: async () => { calls.push("gemini"); return { sent: true }; },
  });
  for (const file of ["ai-providers.js", "provider-delivery.js"]) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, "..", file), "utf8"), context);
  }
  const popup = fs.readFileSync(path.join(__dirname, "../popup.html"), "utf8");
  const providers = vm.runInContext("AIProviders.all", context);
  const deliver = vm.runInContext("deliverToDestination", context);
  for (const provider of providers) {
    if (provider.sending) {
      assert.ok(popup.includes(`src="${provider.id}-adapter.js"`));
      assert.ok(popup.indexOf(`src="${provider.id}-adapter.js"`) < popup.indexOf('src="provider-delivery.js"'));
      assert.equal((await deliver({ providerId: provider.id }, {})).sent, true);
    } else {
      await assert.rejects(deliver({ providerId: provider.id }, {}), (error) => error.unavailable === true);
    }
  }
  assert.deepEqual(calls, ["chatgpt", "claude", "gemini"]);
});
