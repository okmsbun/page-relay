const test = require("node:test");
const assert = require("node:assert/strict");
const { chmodSync, mkdtempSync, readdirSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const {
  buildChromeArgs,
  createOutputTail,
  launchChrome,
  parseDevToolsUrl,
  resolveChromeExecutable,
  terminateProcess,
} = require("./chrome-cdp.cjs");
const { spawn } = require("node:child_process");

test("resolveChromeExecutable respects CHROME_BIN and platform fallbacks", () => {
  assert.equal(
    resolveChromeExecutable({
      env: { CHROME_BIN: "/custom/chrome" },
      exists: (p) => p === "/custom/chrome",
    }),
    "/custom/chrome",
  );

  assert.throws(
    () =>
      resolveChromeExecutable({
        env: { CHROME_BIN: "/missing/chrome" },
        exists: () => false,
      }),
    /CHROME_BIN does not exist/,
  );

  assert.equal(
    resolveChromeExecutable({
      env: {},
      platform: "linux",
      exists: (p) => p === "/usr/bin/google-chrome-stable",
    }),
    "/usr/bin/google-chrome-stable",
  );

  assert.equal(
    resolveChromeExecutable({
      env: {},
      platform: "darwin",
      exists: () => false,
    }),
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  );
});

test("buildChromeArgs uses ephemeral DevTools port and Linux CI safe flags", () => {
  const ciArgs = buildChromeArgs({
    profileDir: "/tmp/profile-1",
    env: { CI: "true" },
  });
  assert.ok(ciArgs.includes("--headless=new"));
  assert.ok(ciArgs.includes("--disable-dev-shm-usage"));
  assert.ok(ciArgs.includes("--remote-debugging-port=0"));
  assert.ok(ciArgs.includes("--remote-allow-origins=*"));
  assert.ok(ciArgs.includes("--no-sandbox"));
  assert.ok(ciArgs.includes("--disable-setuid-sandbox"));
  assert.ok(!ciArgs.includes("--remote-debugging-pipe"));

  const localArgs = buildChromeArgs({
    profileDir: "/tmp/profile-2",
    env: {},
  });
  assert.ok(!localArgs.includes("--no-sandbox"));
  assert.ok(localArgs.includes("--disable-dev-shm-usage"));
});

test("parseDevToolsUrl extracts ws URL even with surrounding stderr noise", () => {
  const sample = [
    "[1234:5678:WARNING:dbus.cc(10)] Failed to connect to the bus",
    "DevTools listening on ws://127.0.0.1:41235/devtools/browser/1111-2222\r",
    "some trailing log",
  ].join("\n");
  assert.equal(
    parseDevToolsUrl(sample),
    "ws://127.0.0.1:41235/devtools/browser/1111-2222",
  );
  assert.equal(parseDevToolsUrl("no endpoint here"), null);
});

test("createOutputTail bounds retained stderr text", () => {
  const tail = createOutputTail(10);
  tail.append("123456");
  tail.append("7890abcd");
  assert.equal(tail.text(), "567890abcd");
});

test("launchChrome surfaces Chrome stderr and cleans up profile on early startup exit", async () => {
  const prefix = `pagerelay-cdp-fail-${Date.now()}-`;
  const before = new Set(readdirSync(tmpdir()).filter((name) => name.startsWith(prefix)));
  const binDir = mkdtempSync(path.join(tmpdir(), "pagerelay-fake-chrome-"));
  const fakeChrome = path.join(binDir, "fake-chrome.sh");
  writeFileSync(
    fakeChrome,
    "#!/bin/sh\necho 'simulated startup failure' >&2\nexit 42\n",
    "utf8",
  );
  chmodSync(fakeChrome, 0o755);

  try {
    await assert.rejects(
      () =>
        launchChrome({
          prefix,
          env: { CHROME_BIN: fakeChrome },
          startupTimeoutMs: 5000,
        }),
      (error) => {
        assert.match(error.message, /Chrome exited before DevTools endpoint became ready/);
        assert.match(error.message, /exitCode=42/);
        assert.match(error.message, /simulated startup failure/);
        return true;
      },
    );
  } finally {
    rmSync(binDir, { recursive: true, force: true });
  }

  const after = readdirSync(tmpdir()).filter((name) => name.startsWith(prefix));
  assert.deepEqual(
    after.filter((name) => !before.has(name)),
    [],
    "temporary Chrome profile directory must be cleaned up on startup failure",
  );
});

test("terminateProcess escalates from SIGTERM to SIGKILL when a child ignores SIGTERM", async () => {
  const child = spawn(
    process.execPath,
    ["-e", "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000);"],
    { stdio: ["ignore", "pipe", "ignore"] },
  );
  await new Promise((resolve, reject) => {
    child.stdout.once("data", resolve);
    child.once("error", reject);
  });

  const startedAt = Date.now();
  await terminateProcess(child, { sigtermGraceMs: 150, sigkillGraceMs: 2000 });
  const elapsedMs = Date.now() - startedAt;

  assert.equal(child.signalCode, "SIGKILL");
  assert.ok(elapsedMs < 2000, `expected bounded termination, took ${elapsedMs}ms`);
});
