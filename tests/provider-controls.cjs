// Native pointer/keyboard checks against the actual panel HTML/CSS in a fixture.
// Headless only, with no account access and no visible temporary Chrome window.
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const assert = require("node:assert/strict");
const { launchChrome } = require("./chrome-cdp.cjs");

async function main() {
  const browser = await launchChrome({ prefix: "pagerelay-controls-" });
  let sessionId;
  const call = (method, params = {}, session = sessionId) =>
    browser.call(method, params, session);

  async function evaluate(expression) {
    const result = await call("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) {
      throw new Error(
        result.exceptionDetails.text + ": " + result.exceptionDetails.exception?.description,
      );
    }
    return result.result.value;
  }

  async function click(selector, fx = 0.5, fy = 0.5) {
    const point = await evaluate(`(() => {
      const {doc, frame} = panelFixture, e = doc.querySelector(${JSON.stringify(selector)});
      e.scrollIntoView({block:'center', inline:'nearest'});
      const r=e.getBoundingClientRect(), f=frame.getBoundingClientRect();
      return {x:f.left+r.left+r.width*${fx},y:f.top+r.top+r.height*${fy}};
    })()`);
    await call("Input.dispatchMouseEvent", { type: "mouseMoved", ...point });
    await call("Input.dispatchMouseEvent", {
      type: "mousePressed",
      ...point,
      button: "left",
      clickCount: 1,
    });
    await call("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      ...point,
      button: "left",
      clickCount: 1,
    });
  }

  async function key(k, code, virtualKey) {
    const params = { key: k, code, windowsVirtualKeyCode: virtualKey };
    await call("Input.dispatchKeyEvent", {
      type: "keyDown",
      ...params,
      ...(k === "Enter" ? { text: "\r" } : k === " " ? { text: " " } : {}),
    });
    await call("Input.dispatchKeyEvent", { type: "keyUp", ...params });
  }

  const selected = () =>
    evaluate(`panelFixture.doc.querySelector('[role=tab][aria-selected=true]').id`);

  const limit = setTimeout(() => {
    console.error("FAIL native controls timed out");
    process.exitCode = 1;
    browser.close().catch(() => {});
  }, 30000);
  limit.unref?.();

  try {
    const { targetId } = await browser.call("Target.createTarget", { url: "about:blank" });
    ({ sessionId } = await browser.call("Target.attachToTarget", { targetId, flatten: true }));
    const url = pathToFileURL(path.join(__dirname, "panel-states.html"));
    url.search = "?interaction";
    await call("Page.navigate", { url: url.href });
    const fixtureDeadline = Date.now() + 15000;
    while (!(await evaluate("!!window.panelFixture"))) {
      if (Date.now() >= fixtureDeadline) {
        throw new Error("Timed out waiting for panelFixture");
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    for (const width of [300, 380, 480]) {
      await evaluate(`panelFixture.frame.style.width='${width}px'`);
      for (const provider of ["chatgpt", "claude", "gemini"]) {
        for (const [x, y] of [
          [0.03, 0.5],
          [0.97, 0.5],
          [0.5, 0.08],
          [0.5, 0.92],
          [0.3, 0.5],
        ]) {
          await click("#provider-" + (provider === "claude" ? "gemini" : "claude"));
          await click("#provider-" + provider, x, y);
          assert.equal(await selected(), "provider-" + provider, `${width}px ${provider} at ${x},${y}`);
        }
      }
    }
    await click("#provider-chatgpt");
    assert.equal(await evaluate("panelFixture.doc.getElementById('destination-10').checked"), true);
    await click(".destination-row", 0.97, 0.5);
    assert.equal(await evaluate("panelFixture.doc.getElementById('destination-10').checked"), false);
    await click(".destination-row", 0.97, 0.5);
    assert.equal(await evaluate("panelFixture.doc.getElementById('destination-10').checked"), true);
    await click("#provider-gemini");
    await click("#provider-chatgpt .provider-count");
    assert.equal(await selected(), "provider-chatgpt");
    await evaluate("panelFixture.doc.getElementById('provider-chatgpt').focus()");
    await key("ArrowRight", "ArrowRight", 39);
    assert.equal(await selected(), "provider-claude");
    await key("End", "End", 35);
    assert.equal(await selected(), "provider-gemini");
    await key("Home", "Home", 36);
    assert.equal(await selected(), "provider-chatgpt");
    await evaluate("panelFixture.doc.getElementById('provider-claude').focus()");
    await key("Enter", "Enter", 13);
    assert.equal(await selected(), "provider-claude");
    await evaluate("panelFixture.doc.getElementById('provider-gemini').focus()");
    await key(" ", "Space", 32);
    assert.equal(await selected(), "provider-gemini");
    await key("Tab", "Tab", 9);
    assert.equal(await evaluate("panelFixture.doc.activeElement.id"), "destinationSearch");
    console.log(
      "PASS native pointer: three providers × five hit points × three widths, badge, row padding; keyboard: arrows, Home/End, Enter, Space, Tab",
    );
  } finally {
    clearTimeout(limit);
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
