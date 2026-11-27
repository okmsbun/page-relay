// Local fixtures in headless Chrome. Real async File/Blob reads must finish before
// collecting results: --dump-dom's virtual-time budget can expire during those reads.
// No signed-in profile, external site, or visible browser window is used.
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { launchChrome } = require("./chrome-cdp.cjs");

async function main() {
  const browser = await launchChrome({ prefix: "capture-browser-" });
  let sessionId;
  const call = (method, params = {}) => browser.call(method, params, sessionId);

  async function check(file, query = "") {
    const url = pathToFileURL(path.join(__dirname, file));
    url.search = query;
    await call("Page.navigate", { url: url.href });
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const output = await call("Runtime.evaluate", {
        expression: `location.href === ${JSON.stringify(url.href)} ? document.getElementById('result')?.textContent : ''`,
        returnByValue: true,
      });
      if (output.exceptionDetails) {
        throw new Error(`${file}: ${output.exceptionDetails.text}`);
      }
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

  try {
    const { targetId } = await browser.call("Target.createTarget", { url: "about:blank" });
    ({ sessionId } = await browser.call("Target.attachToTarget", { targetId, flatten: true }));
    await check("scroll-targets.html", "?verify");
    await check("panel-states.html");
    await check("page-text.html");
    await check("chatgpt-adapter.html");
    await check("chatgpt-verification.html", "?edge-cases");
    await check("provider-adapters.html", "?provider=claude");
    await check("provider-adapters.html", "?provider=gemini");
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
