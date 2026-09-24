// OPT-IN, ISOLATED automated check - NOT live verification.
//
// This script launches its own throwaway Chrome with a temporary, empty profile and
// closes it when done. It never touches the user's normal profile or their open tabs,
// and a pass here does NOT count as live verification of the four manual Side Panel
// cases in INTEGRATIONS.md; those are performed by the user in their own Chrome.
//
// What it does check automatically: it loads the unpacked extension into that isolated
// Chrome, clicks the extension action through Chrome's own action pipeline (CDP
// Extensions.triggerAction, a genuine toolbar click), keeps Chrome's native Side Panel
// open and reads the real panel document. It covers the regression that unit fixtures
// cannot see: a Side Panel cannot borrow activeTab from the toolbar click, so the source
// page needs declared host access.
//
// It opens a visible Chrome window while it runs; run it only when that is acceptable.
//
// Run: node tests/sidepanel-e2e.cjs                 (needs Chrome + network)
//      CHROME_BIN=/path/to/chrome node tests/sidepanel-e2e.cjs
//      NORMAL_URL=... ADMOB_URL=... AI_URL=... node tests/sidepanel-e2e.cjs
const { spawn } = require("node:child_process");
const { mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const net = require("node:net");

const CHROME =
  process.env.CHROME_BIN ||
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const EXTENSION = path.join(__dirname, "..");
const NORMAL_URL = process.env.NORMAL_URL || "https://github.com/";
const ADMOB_URL = process.env.ADMOB_URL || "https://apps.admob.com/v2/home";
const AI_URL = process.env.AI_URL || "https://chatgpt.com/";
const PROTECTED_URL = "chrome://extensions";
// Chrome hides tab targets unless they are requested explicitly.
const TARGET_FILTER = [
  { type: "browser", exclude: true },
  { type: "tab", exclude: false },
  { exclude: false },
];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const site = (url) =>
  /^([a-z-]+:)\/\/([^/]*)/i.exec(url)?.slice(1).join("") ?? url;

const PANEL_STATE = `(() => {
  const preview = document.getElementById("preview");
  return {
    state: document.body?.dataset?.state ?? null,
    detail: document.getElementById("statusDetail")?.textContent ?? "",
    preview: (preview?.src ?? "").length,
    meta: document.getElementById("imageMeta")?.textContent ?? "",
    text: (document.getElementById("textPreview")?.textContent ?? "").slice(0, 60),
    showing: document.getElementById("previewViewport")?.hidden === false,
    emptyHeading: document.getElementById("emptyState")?.querySelector("h2")?.textContent ?? "",
  };
})()`;

function freePort() {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.next = 0;
    this.pending = new Map();
    ws.addEventListener("message", (event) =>
      this.onMessage(JSON.parse(event.data)),
    );
  }
  onMessage(message) {
    if (!message.id || !this.pending.has(message.id)) return;
    const { resolve, reject } = this.pending.get(message.id);
    this.pending.delete(message.id);
    message.error
      ? reject(new Error(message.error.message))
      : resolve(message.result);
  }
  send(method, params = {}, sessionId) {
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(
        JSON.stringify({
          id,
          method,
          params,
          ...(sessionId ? { sessionId } : {}),
        }),
      );
    });
  }
  async evaluate(sessionId, expression) {
    const result = await this.send(
      "Runtime.evaluate",
      { expression, awaitPromise: true, returnByValue: true },
      sessionId,
    );
    if (result.exceptionDetails)
      throw new Error(
        result.exceptionDetails.exception?.description ?? "evaluate failed",
      );
    return result.result.value;
  }
  targets() {
    return this.send("Target.getTargets", { filter: TARGET_FILTER }).then(
      (r) => r.targetInfos,
    );
  }
  async attach(targetId) {
    const { sessionId } = await this.send("Target.attachToTarget", {
      targetId,
      flatten: true,
    });
    return sessionId;
  }
}

async function waitFor(label, predicate, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await predicate();
    if (last) return last;
    await sleep(250);
  }
  throw new Error(`${label} timed out (last: ${JSON.stringify(last)})`);
}

async function launch(url) {
  const profile = mkdtempSync(path.join(tmpdir(), "capture-e2e-"));
  const port = await freePort();
  const child = spawn(
    CHROME,
    [
      `--user-data-dir=${profile}`,
      `--remote-debugging-port=${port}`,
      "--remote-allow-origins=*",
      "--enable-unsafe-extension-debugging",
      "--no-first-run",
      "--no-default-browser-check",
      "--window-size=1400,1000",
      "--window-position=0,0",
      url,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  child.stderr.on("data", () => {});
  let version;
  for (let i = 0; i < 100 && !version; i++) {
    try {
      version = await (
        await fetch(`http://127.0.0.1:${port}/json/version`)
      ).json();
    } catch {
      await sleep(300);
    }
  }
  if (!version) throw new Error("Chrome did not expose a debugging endpoint");
  const ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });
  const cdp = new CDP(ws);
  const { id } = await cdp.send("Extensions.loadUnpacked", { path: EXTENSION });
  return {
    cdp,
    browser: version.Browser,
    extensionId: id,
    close: () => {
      child.kill();
      setTimeout(() => rmSync(profile, { recursive: true, force: true }), 500);
    },
  };
}

async function main() {
  const { cdp, browser, extensionId, close } = await launch(NORMAL_URL);
  const results = [];
  const check = (ok, label, detail = "") => {
    console.log(
      `${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` - ${detail}` : ""}`,
    );
    results.push(ok);
  };
  try {
    console.log(`Chrome: ${browser}\nextension: ${extensionId}\n`);

    const panelUrl = `chrome-extension://${extensionId}/sidepanel.html`;
    const sw = await (async () => {
      const target = await waitFor(
        "extension service worker",
        async () =>
          (await cdp.targets()).find(
            (t) =>
              t.url === `chrome-extension://${extensionId}/service-worker.js`,
          ),
        30000,
      );
      return cdp.attach(target.targetId);
    })();
    const manifest = await cdp.evaluate(sw, "chrome.runtime.getManifest()");
    check(
      manifest.host_permissions.includes("<all_urls>"),
      "capture sources have declared host access",
      JSON.stringify(manifest.host_permissions),
    );
    check(
      ["scripting", "sidePanel", "storage", "tabs"].every((p) =>
        manifest.permissions.includes(p),
      ),
      "MV3 permissions present",
      JSON.stringify(manifest.permissions),
    );

    const activeTab = () =>
      cdp.evaluate(
        sw,
        "(async () => { const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true }); return t && { id: t.id, windowId: t.windowId, url: t.url }; })()",
      );
    const pinnedSource = () =>
      cdp
        .evaluate(sw, 'chrome.storage.session.get("captureSourceTab")')
        .then((result) => result?.captureSourceTab ?? null);
    const tabTarget = async (prefix) =>
      (await cdp.targets()).find(
        (t) => t.type === "tab" && t.url.startsWith(prefix),
      );

    // Focuses an existing tab, or opens a new one, and waits until the extension sees it
    // as the active tab of the window (the state a real toolbar click starts from).
    async function activate(url, { expectSite = true } = {}) {
      const existing = await tabTarget(url);
      let activatedId = null;
      if (existing) {
        activatedId = existing.targetId;
        await cdp.send("Target.activateTarget", {
          targetId: existing.targetId,
        });
      } else {
        const { targetId } = await cdp.send("Target.createTarget", { url });
        activatedId = targetId;
        await cdp.send("Target.activateTarget", { targetId });
      }
      return waitFor(
        `active tab for ${url}`,
        async () => {
          const tab = await activeTab();
          if (!tab?.url) return null;
          const expected = expectSite ? site(url) : null;
          return tab.url.startsWith(url) || expected === site(tab.url)
            ? tab
            : null;
        },
        30000,
      );
    }

    // A tab target is what Chrome's action pipeline needs; it can redirect while loading.
    const tabTargetForActive = (label) =>
      waitFor(
        `${label}: tab target`,
        async () => {
          const tab = await activeTab();
          if (!tab?.url) return null;
          const tabs = (await cdp.targets()).filter(
            (t) =>
              t.type === "tab" &&
              t.url &&
              t.url !== panelUrl &&
              !t.url.startsWith("chrome-extension://"),
          );
          return (
            tabs.find((t) => t.url === tab.url) ??
            tabs.find((t) => site(t.url) === site(tab.url)) ??
            null
          );
        },
        20000,
      );

    // Chrome's own action pipeline: a genuine toolbar click, not a simulated API call.
    const clickAction = (target) =>
      cdp.send("Extensions.triggerAction", {
        id: extensionId,
        targetId: target.targetId,
      });

    const panelSession = async () =>
      cdp.attach(
        (
          await waitFor(
            "side panel document",
            async () => (await cdp.targets()).find((t) => t.url === panelUrl),
            30000,
          )
        ).targetId,
      );

    let previous = null;
    // Clicks the real action, then waits for the panel to leave its previous session and
    // settle on the new one.
    async function captureViaAction(label) {
      const active = await waitFor(
        `${label}: active tab committed`,
        async () => {
          const tab = await activeTab();
          return tab?.url ? tab : null;
        },
        30000,
      );
      const clickedAt = Date.now();
      await clickAction(await tabTargetForActive(label));
      const pin = await waitFor(
        `${label}: toolbar click pins the source tab`,
        async () => {
          const value = await pinnedSource();
          return value?.pinnedAt >= clickedAt && value.id === active.id
            ? value
            : null;
        },
        15000,
      );
      const session = await panelSession();
      const before = previous;
      const deadline = Date.now() + 240000;
      let settled = null;
      let leftPrevious = before === null;
      while (Date.now() < deadline) {
        const state = await cdp.evaluate(session, PANEL_STATE);
        if (!leftPrevious)
          leftPrevious =
            state.state !== before.state ||
            state.preview !== before.preview ||
            state.meta !== before.meta ||
            state.detail !== before.detail;
        if (
          leftPrevious &&
          (state.state === "success" || state.state === "error")
        ) {
          settled = state;
          break;
        }
        await sleep(200);
      }
      if (!settled) throw new Error(`${label}: the panel never settled`);
      previous = settled;
      return { settled, pin, session };
    }

    // 1. A normal HTTPS page must capture.
    await activate(NORMAL_URL);
    const normal = await captureViaAction("github");
    check(
      normal.settled.state === "success" && normal.settled.showing,
      `${NORMAL_URL} captured through the native Side Panel`,
      `${normal.settled.meta} · preview ${normal.settled.preview} chars`,
    );

    // 4. Switching to another (AI) tab must not replace the captured source.
    const beforeSwitch = await cdp.evaluate(normal.session, PANEL_STATE);
    const { targetId: aiTarget } = await cdp.send("Target.createTarget", {
      url: AI_URL,
    });
    await cdp.send("Target.activateTarget", { targetId: aiTarget });
    await waitFor(
      "AI tab active",
      async () => {
        const tab = await activeTab();
        return tab?.id !== normal.pin.id && tab?.url ? tab : null;
      },
      30000,
    );
    const switched = [];
    for (let i = 0; i < 10; i++) {
      await sleep(400);
      switched.push(await cdp.evaluate(normal.session, PANEL_STATE));
    }
    check(
      switched.every(
        (state) =>
          state.state === "success" &&
          state.preview === beforeSwitch.preview &&
          state.text === beforeSwitch.text &&
          state.meta === beforeSwitch.meta,
      ),
      "switching to another tab keeps the captured source and preview",
      `${switched.at(-1).state} · ${switched.at(-1).meta}`,
    );

    // 2. Google AdMob must capture too (it redirects to a Google sign-in page).
    await activate(ADMOB_URL, { expectSite: false });
    const admob = await captureViaAction("admob");
    check(
      admob.settled.state === "success" &&
        admob.settled.showing &&
        admob.settled.meta !== beforeSwitch.meta,
      `${ADMOB_URL} captured through the native Side Panel`,
      `${admob.settled.meta} · source ${admob.pin.url}`,
    );

    // 3. A genuinely protected page must still report the protected-page error.
    await activate(PROTECTED_URL);
    const blocked = await captureViaAction("chrome-extensions");
    check(
      blocked.settled.state === "error" &&
        /protects this page from scrolling access/.test(blocked.settled.detail),
      `${PROTECTED_URL} reports the real protected-page error`,
      blocked.settled.detail.slice(0, 80),
    );
    check(
      !blocked.settled.showing &&
        blocked.settled.emptyHeading === "Preview unavailable",
      "a protected page exposes no stale capture",
      `${blocked.settled.emptyHeading} · ${blocked.settled.meta}`,
    );

    // A normal page must capture again afterwards, not keep the protected-page error.
    await activate(NORMAL_URL);
    const recovered = await captureViaAction("github again");
    check(
      recovered.settled.state === "success" && recovered.settled.showing,
      "a normal page captures again after a protected page",
      recovered.settled.meta,
    );
  } finally {
    close();
  }
  const failed = results.filter((ok) => !ok).length;
  console.log(
    `\n${results.length - failed}/${results.length} real-browser checks passed`,
  );
  if (failed) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`\nE2E ERROR: ${error.message}`);
  process.exitCode = 1;
});
