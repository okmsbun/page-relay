// Native pointer/keyboard checks against the actual panel HTML/CSS in a fixture.
// Headless only, with no account access and no visible temporary Chrome window.
const { spawn } = require("node:child_process");
const { mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const assert = require("node:assert/strict");
const profile = mkdtempSync(path.join(tmpdir(), "pagerelay-controls-"));
const child = spawn(process.env.CHROME_BIN || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", [
  "--headless", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
  "--disable-background-networking", "--disable-component-update", "--allow-file-access-from-files",
  "--remote-debugging-pipe", `--user-data-dir=${profile}`, "about:blank",
], { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] });
let serial = 0, buffer = "", sessionId;
const pending = new Map();
child.on("error", (error) => { for (const call of pending.values()) call.reject(error); pending.clear(); });
child.on("exit", () => { for (const call of pending.values()) call.reject(new Error("Headless Chrome exited")); pending.clear(); });
child.stdio[4].on("data", (chunk) => {
  buffer += chunk;
  let end;
  while ((end = buffer.indexOf("\0")) !== -1) {
    const message = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
    const call = pending.get(message.id);
    if (call) { pending.delete(message.id); message.error ? call.reject(new Error(message.error.message)) : call.resolve(message.result); }
  }
});
function call(method, params = {}, session = sessionId) {
  return new Promise((resolve, reject) => {
    const id = ++serial; pending.set(id, { resolve, reject });
    child.stdio[3].write(JSON.stringify({ id, method, params, ...(session ? { sessionId: session } : {}) }) + "\0");
  });
}
async function evaluate(expression) {
  const result = await call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text + ": " + result.exceptionDetails.exception?.description);
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
  await call("Input.dispatchMouseEvent", { type: "mousePressed", ...point, button: "left", clickCount: 1 });
  await call("Input.dispatchMouseEvent", { type: "mouseReleased", ...point, button: "left", clickCount: 1 });
}
async function key(key, code, virtualKey) {
  const params = { key, code, windowsVirtualKeyCode: virtualKey };
  await call("Input.dispatchKeyEvent", { type: "keyDown", ...params,
    ...(key === "Enter" ? { text: "\r" } : key === " " ? { text: " " } : {}) });
  await call("Input.dispatchKeyEvent", { type: "keyUp", ...params });
}
const selected = () => evaluate(`panelFixture.doc.querySelector('[role=tab][aria-selected=true]').id`);
const limit = setTimeout(() => { console.error("FAIL native controls timed out"); child.kill(); process.exitCode = 1; }, 30000);
(async () => {
  const { targetId } = await call("Target.createTarget", { url: "about:blank" });
  ({ sessionId } = await call("Target.attachToTarget", { targetId, flatten: true }));
  const url = pathToFileURL(path.join(__dirname, "panel-states.html")); url.search = "?interaction";
  await call("Page.navigate", { url: url.href });
  while (!await evaluate("!!window.panelFixture")) await new Promise((resolve) => setTimeout(resolve, 50));
  for (const width of [300, 380, 480]) {
    await evaluate(`panelFixture.frame.style.width='${width}px'`);
    for (const provider of ["chatgpt", "claude", "gemini"]) {
      for (const [x, y] of [[0.03, 0.5], [0.97, 0.5], [0.5, 0.08], [0.5, 0.92], [0.3, 0.5]]) {
        await click("#provider-" + (provider === "claude" ? "gemini" : "claude"));
        await click("#provider-" + provider, x, y);
        assert.equal(await selected(), "provider-" + provider, `${width}px ${provider} at ${x},${y}`);
      }
    }
  }
  await click("#provider-chatgpt");
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
  console.log("PASS native pointer: three providers × five hit points × three widths, badge, row padding; keyboard: arrows, Home/End, Enter, Space, Tab");
})().catch((error) => { console.error(error); process.exitCode = 1; }).finally(async () => {
  clearTimeout(limit);
  if (child.exitCode === null && child.signalCode === null) {
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill(); await exited;
  }
  rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});
