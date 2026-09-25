// Local fixtures in headless Chrome. Real async File/Blob reads must finish before
// collecting results: --dump-dom's virtual-time budget can expire during those reads.
// No signed-in profile, external site, or visible browser window is used.
const { spawn } = require("node:child_process");
const { mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const profile = mkdtempSync(path.join(tmpdir(), "capture-browser-"));
const child = spawn(process.env.CHROME_BIN || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", [
  "--headless", "--disable-gpu", "--disable-background-networking", "--disable-component-update",
  "--no-first-run", "--no-default-browser-check", `--user-data-dir=${profile}`,
  "--allow-file-access-from-files", "--remote-debugging-pipe", "about:blank",
], { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] });
let serial = 0, buffer = "", sessionId;
const pending = new Map();
const failPending = (error) => {
  for (const call of pending.values()) { clearTimeout(call.timer); call.reject(error); }
  pending.clear();
};
child.on("error", failPending);
child.on("exit", () => failPending(new Error("Headless Chrome exited")));
child.stdio[4].on("data", (chunk) => {
  buffer += chunk;
  let end;
  while ((end = buffer.indexOf("\0")) !== -1) {
    const message = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
    const call = pending.get(message.id);
    if (call) {
      pending.delete(message.id); clearTimeout(call.timer);
      message.error ? call.reject(new Error(message.error.message)) : call.resolve(message.result);
    }
  }
});
function call(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++serial;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, 10000);
    pending.set(id, { resolve, reject, timer });
    child.stdio[3].write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + "\0");
  });
}
async function check(file, query = "") {
  const url = pathToFileURL(path.join(__dirname, file)); url.search = query;
  await call("Page.navigate", { url: url.href });
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const output = await call("Runtime.evaluate", {
      expression: `location.href === ${JSON.stringify(url.href)} ? document.getElementById('result')?.textContent : ''`,
      returnByValue: true,
    });
    if (output.exceptionDetails) throw new Error(`${file}: ${output.exceptionDetails.text}`);
    const result = output.result.value || "";
    if (/^(PASS|FAIL) /.test(result)) {
      console.log(`${file}${query}: ${result}`);
      if (result.startsWith("FAIL")) throw new Error(`${file}: ${result}`);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`${file}: timed out`);
}
(async () => {
  const { targetId } = await call("Target.createTarget", { url: "about:blank" });
  ({ sessionId } = await call("Target.attachToTarget", { targetId, flatten: true }));
  await check("scroll-targets.html", "?verify");
  await check("panel-states.html");
  await check("page-text.html");
  await check("chatgpt-adapter.html");
  await check("chatgpt-verification.html", "?edge-cases");
  await check("provider-adapters.html", "?provider=claude");
  await check("provider-adapters.html", "?provider=gemini");
})().catch((error) => {
  console.error(error.message); process.exitCode = 1;
}).finally(async () => {
  if (child.exitCode === null && child.signalCode === null) {
    const exited = new Promise((resolve) => child.once("exit", resolve)); child.kill(); await exited;
  }
  rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});
