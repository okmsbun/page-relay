// No DevTools Protocol: exercise fixtures with Chrome's headless CLI.
// Run: node tests/browser-check.cjs (set CHROME_BIN on non-macOS systems).
const { spawn } = require("node:child_process");
const { mkdtempSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const chrome = process.env.CHROME_BIN || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

async function check(file, query) {
  const url = pathToFileURL(path.join(__dirname, file));
  url.search = query;
  const profile = mkdtempSync(path.join(tmpdir(), "capture-browser-"));
  return new Promise((resolve, reject) => {
    const child = spawn(chrome, ["--headless", "--disable-gpu", "--disable-background-networking",
      "--disable-component-update", "--no-first-run", "--no-default-browser-check",
      `--user-data-dir=${profile}`, "--allow-file-access-from-files", "--dump-dom",
      "--virtual-time-budget=20000", url.href], { stdio: ["ignore", "pipe", "ignore"] });
    let output = "", completed = false;
    const timeout = setTimeout(() => { child.kill(); reject(new Error(`${file}: timed out`)); }, 30000);
    child.on("error", (error) => { clearTimeout(timeout); reject(error); });
    child.stdout.on("data", (data) => {
      output += data;
      const result = output.match(/<pre id="result"[^>]*>(PASS|FAIL) ([\s\S]*?)<\/pre>/);
      if (!result || completed) return;
      completed = true;
      clearTimeout(timeout);
      child.kill();
      console.log(`${file}: ${result[1]} ${result[2]}`);
      result[1] === "PASS" ? resolve() : reject(new Error(`${file}: ${result[2]}`));
    });
    child.on("exit", () => {
      clearTimeout(timeout);
      if (!completed) reject(new Error(`${file}: browser exited without a test result`));
    });
  });
}
(async () => {
  await check("scroll-targets.html", "?verify");
  await check("popup-states.html", "");
  await check("page-text.html", "");
  await check("chatgpt-adapter.html", "");
  await check("chatgpt-verification.html", "");
  await check("chatgpt-verification.html", "?unconfirmed");
  await check("provider-adapters.html", "?provider=claude");
  await check("provider-adapters.html", "?provider=gemini");
})().catch((error) => { console.error(error.message); process.exitCode = 1; });
