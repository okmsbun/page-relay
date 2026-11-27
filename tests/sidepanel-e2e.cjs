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
// cannot see: the toolbar click must grant activeTab access to the source page,
// and the Side Panel must be able to use that grant for capture.
//
// By default it opens a visible Chrome window; HEADLESS=1 avoids a visible profile.
//
// Run: node tests/sidepanel-e2e.cjs                 (needs Chrome + network)
//      CHROME_BIN=/path/to/chrome node tests/sidepanel-e2e.cjs
//      NORMAL_URL=... ADMOB_URL=... AI_URL=... node tests/sidepanel-e2e.cjs
//      HEADLESS=1 node tests/sidepanel-e2e.cjs
const path = require("node:path");
const { launchChrome } = require("./chrome-cdp.cjs");

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
    title: document.getElementById("statusTitle")?.textContent ?? "",
    detail: document.getElementById("statusDetail")?.textContent ?? "",
    hint: document.getElementById("statusHint")?.textContent ?? "",
    preview: (preview?.src ?? "").length,
    meta: document.getElementById("imageMeta")?.textContent ?? "",
    text: (document.getElementById("textPreview")?.textContent ?? "").slice(0, 60),
    showing: document.getElementById("previewViewport")?.hidden === false,
    previewCardHidden: document.querySelector(".preview-card")?.hidden === true,
    emptyHeading: document.getElementById("emptyState")?.querySelector("h2")?.textContent ?? "",
  };
})()`;

class CDP {
  constructor(call) {
    this._call = call;
  }
  send(method, params = {}, sessionId) {
    return this._call(method, params, sessionId, 30000);
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

async function launch(url, {
  headless = process.env.HEADLESS === "1",
  deviceScaleFactor = process.env.DPR,
  windowSize = "1400,1000",
  extensionPath = EXTENSION,
} = {}) {
  const browser = await launchChrome({
    prefix: "capture-e2e-",
    headless,
    allowFileAccess: false,
    disableExtensions: false,
    enableUnsafeExtensionDebugging: true,
    deviceScaleFactor,
    windowSize,
    windowPosition: "0,0",
    url,
  });
  try {
    const cdp = new CDP(browser.call);
    const version = await cdp.send("Browser.getVersion");
    const { id } = await cdp.send("Extensions.loadUnpacked", { path: extensionPath });
    return {
      cdp,
      browser: version.product,
      extensionId: id,
      close: () => browser.close(),
    };
  } catch (error) {
    await browser.close();
    throw error;
  }
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
      manifest.permissions.includes("activeTab") &&
        !manifest.host_permissions.includes("<all_urls>"),
      "capture sources use the toolbar click's activeTab grant",
      JSON.stringify({ permissions: manifest.permissions, hosts: manifest.host_permissions }),
    );
    check(
      ["activeTab", "scripting", "sidePanel", "storage", "tabs"].every((p) =>
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
          (state.state === "success" ||
            state.state === "error" ||
            state.state === "restricted")
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

    // 2. Switching to a new ungranted tab -> clicking Capture this tab shows calm
    // Page access required while preserving the previous capture, and clicking the
    // real toolbar icon recovers automatically without closing/reopening the panel.
    await activate(ADMOB_URL, { expectSite: false });
    await sleep(800);
    await cdp.evaluate(
      normal.session,
      'document.getElementById("captureActiveTab")?.click()',
    );
    const permState = await waitFor(
      "permission state after Capture this tab",
      async () => {
        const st = await cdp.evaluate(normal.session, PANEL_STATE);
        return st.state === "permission" ? st : null;
      },
      15000,
    );
    check(
      permState.state === "permission" &&
        permState.title === "Page access required" &&
        permState.showing &&
        permState.preview === beforeSwitch.preview,
      "Capture this tab on an ungranted tab shows Page access required and preserves previous capture",
      `${permState.title}: ${permState.hint}`,
    );
    const admob = await captureViaAction("admob");
    check(
      admob.settled.state === "success" &&
        admob.settled.showing &&
        admob.settled.meta !== beforeSwitch.meta,
      `${ADMOB_URL} recovered automatically via toolbar click without reopening the Side Panel`,
      `${admob.settled.meta} · source ${admob.pin.url}`,
    );

    // 3. A genuinely restricted page must show the calm restricted-page state while
    // preserving the previous valid capture until a new capture succeeds.
    await activate(PROTECTED_URL);
    const blocked = await captureViaAction("chrome-extensions");
    check(
      blocked.settled.state === "restricted" &&
        blocked.settled.title === "Restricted page" &&
        /security reasons/.test(blocked.settled.detail),
      `${PROTECTED_URL} reports the calm restricted-page state`,
      `${blocked.settled.title}: ${blocked.settled.detail.slice(0, 80)}`,
    );
    check(
      blocked.settled.showing && /preserved/.test(blocked.settled.hint),
      "clicking toolbar on a restricted page preserves the previous valid capture in-place",
      `hint=${blocked.settled.hint}`,
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
    await close();
  }
  const failed = results.filter((ok) => !ok).length;
  console.log(
    `\n${results.length - failed}/${results.length} real-browser checks passed`,
  );
  if (failed) process.exitCode = 1;
}

module.exports = { launch, waitFor, PANEL_STATE };
if (require.main === module) main().catch((error) => {
  console.error(`\nE2E ERROR: ${error.message}`);
  process.exitCode = 1;
});
