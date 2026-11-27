const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "../panel.js"), "utf8");
// Chrome allows at most two captureVisibleTab calls per second, so the panel's interval
// must stay above the 500ms quota floor; the harness throttles exactly like the panel.
const CAPTURE_INTERVAL_MS = Number(
  /const CAPTURE_INTERVAL_MS = (\d+);/.exec(source)?.[1],
);
test("capture interval respects Chrome's capture quota", () => {
  assert.ok(
    CAPTURE_INTERVAL_MS >= 500 && CAPTURE_INTERVAL_MS < 1000,
    String(CAPTURE_INTERVAL_MS),
  );
});
// The page-side settle window must stay conservative: it is the evidence that a
// position is stable before its pixels are saved.
const CONTENT_SOURCE = fs.readFileSync(
  path.join(__dirname, "../content.js"),
  "utf8",
);
const POLL_MS = Number(/const POLL_MS = (\d+);/.exec(CONTENT_SOURCE)?.[1]);
const QUIET_MS = Number(/const QUIET_MS = (\d+);/.exec(CONTENT_SOURCE)?.[1]);
test("content script keeps a conservative settle window", () => {
  assert.ok(QUIET_MS >= 250, `QUIET_MS ${QUIET_MS}`);
  assert.ok(POLL_MS >= 25 && POLL_MS <= 100, `POLL_MS ${POLL_MS}`);
});

// A fake capture contains its document pixel row numbers. Stitching must preserve
// every row exactly once, even when the browser clamps the last scroll position.
function harness({
  height = 2350,
  viewport = 800,
  scale = 1,
  crop = { x: 0, y: 0, width: 100, height: viewport },
  windowHeight = viewport,
  regions,
  scrollLimit,
  scrollQuantum = 0,
  onMessage,
  onCapture,
} = {}) {
  const state = {
    height,
    y: 0,
    time: 10000,
    captures: [],
    canvases: [],
    restored: false,
    events: [],
    regionIndex: 0,
  };
  const metrics = () => ({
    documentHeight: state.height,
    viewportHeight: viewport,
    viewportWidth: crop.width,
    windowHeight,
    windowWidth: 100,
    devicePixelRatio: scale,
    crop: { ...crop },
    scrollX: 0,
    scrollY: state.y,
    regionIndex: state.regionIndex,
    regions: regions?.map((r) => ({ crop: r.crop, background: "#fff" })),
  });
  class Screenshot {
    set src(value) {
      Object.assign(this, JSON.parse(value));
      queueMicrotask(() => this.onload());
    }
  }
  const context = vm.createContext({
    console,
    Image: Screenshot,
    composeApplicationScreenshot(shell, panels) {
      state.composed = { shell, panels };
      return { toDataURL: () => "data:image/png;base64,composed" };
    },
    Date: { now: () => state.time },
    setTimeout: (callback, ms) => {
      state.time += ms;
      queueMicrotask(callback);
    },
    document: {
      getElementById: () => ({
        style: {},
        addEventListener() {},
        setAttribute() {},
      }),
      createElement() {
        const canvas = {
          rows: [],
          getContext: () => ({
            drawImage(image, sx, sy, sw, sh, dx, dy, dw, dh) {
              if (image.rows) {
                canvas.rows = image.rows.slice(0, canvas.height);
                return;
              }
              assert.equal(
                sx,
                Math.round(crop.x * scale),
                "Exclude surrounding app chrome",
              );
              assert.equal(sw, Math.round((crop.x + crop.width) * scale) - sx);
              assert.equal(sh, dh, "No vertical rescaling at a seam");
              assert.ok(
                sy >= 0 && sy + sh <= image.height,
                "Valid source crop",
              );
              for (let row = 0; row < dh; row++) {
                assert.equal(
                  canvas.rows[dy + row],
                  undefined,
                  "No overwritten rows",
                );
                canvas.rows[dy + row] = image.top + sy + row;
              }
            },
          }),
          toDataURL: () => "data:image/png;base64,test",
        };
        state.canvases.push(canvas);
        return canvas;
      },
    },
    chrome: {
      scripting: { executeScript: async () => {} },
      tabs: {
        connect: () => ({
          disconnect() {
            state.disconnected = true;
          },
        }),
        query: async () => [{ id: state.activeId ?? 1, windowId: 2 }],
        sendMessage: async (_tab, message, options) => {
          assert.equal(options.frameId, 0);
          if (message.type === "fullPageCapture:text")
            return {
              ok: true,
              result: {
                text: "Rendered text",
                characters: 13,
                estimatedTokens: 4,
                title: "Test page",
                url: "https://example.test/",
              },
            };
          if (message.type === "fullPageCapture:select") {
            state.regionIndex = message.index;
            ({ viewport, crop } = regions[message.index]);
            state.height = regions[message.index].height;
            state.y = 0;
          }
          if (message.type === "fullPageCapture:scroll") {
            const requested = scrollQuantum
              ? Math.round(message.scrollY / scrollQuantum) * scrollQuantum
              : message.scrollY;
            state.y = Math.max(
              0,
              Math.min(requested, scrollLimit ?? state.height - viewport),
            );
            state.events.push({
              type: "scroll",
              y: state.y,
              region: state.regionIndex,
            });
          }
          if (message.type === "fullPageCapture:start") state.y = 0;
          if (message.type === "fullPageCapture:restore") state.restored = true;
          await onMessage?.(state, message);
          return { ok: true, result: metrics() };
        },
        captureVisibleTab: async () => {
          const previous = state.captures.at(-1);
          if (previous)
            assert.ok(
              state.time - previous.time >= CAPTURE_INTERVAL_MS - 1,
              "Capture throttle",
            );
          const shot = {
            top: Math.round(state.y * scale) - Math.round(crop.y * scale),
            time: state.time,
            height: Math.round(windowHeight * scale),
            width: Math.round(100 * scale),
          };
          await onCapture?.(state);
          state.captures.push(shot);
          state.events.push({
            type: "capture",
            y: state.y,
            region: state.regionIndex,
          });
          return JSON.stringify(shot);
        },
      },
    },
  });
  vm.runInContext(source, context);
  return { state, run: (expression) => vm.runInContext(expression, context) };
}

test("switching tabs while a segment is captured never stitches the wrong tab and restores the source", async () => {
  const { run, state } = harness({
    onCapture: (state) => {
      state.activeId = 9;
    },
  });
  await assert.rejects(
    run("captureFullPage({id: 1, windowId: 2})"),
    /active tab changed/,
  );
  assert.ok(state.restored && state.disconnected);
  assert.ok(
    state.canvases.every(
      (canvas) => !canvas.rows?.some((row) => row !== undefined),
    ),
  );
});

test("transient Chrome tab-strip lock during captureVisibleTab recovers automatically", async () => {
  let lockCount = 0;
  const { run, state } = harness({
    height: 1600,
    onCapture() {
      if (lockCount < 2) {
        lockCount++;
        throw new Error(
          "Tabs cannot be edited right now (user may be dragging a tab).",
        );
      }
    },
  });
  await run("captureFullPage({id: 1, windowId: 2})");
  assert.equal(lockCount, 2);
  const canvas = state.canvases.at(-1);
  assert.equal(canvas.rows.length, 1600);
  for (let row = 0; row < 1600; row++) assert.equal(canvas.rows[row], row);
  assert.ok(state.restored && state.disconnected);
});

test("transient tab-strip lock recovery aborts safely if active tab changes before retry", async () => {
  let attempts = 0;
  const { run, state } = harness({
    height: 1600,
    onCapture(state) {
      if (attempts++ === 0) {
        state.activeId = 9;
        throw new Error(
          "Tabs cannot be edited right now (user may be dragging a tab).",
        );
      }
    },
  });
  await assert.rejects(
    run("captureFullPage({id: 1, windowId: 2})"),
    /Keep the captured tab active/,
  );
  assert.equal(attempts, 1, "did not retry captureVisibleTab on wrong tab");
  assert.ok(state.restored && state.disconnected);
});

test("persistent Chrome tab-strip lock stops after bounded retries with structured diagnostics", async () => {
  let attempts = 0;
  const { run, state } = harness({
    height: 1600,
    onCapture() {
      attempts++;
      throw new Error(
        "Tabs cannot be edited right now (user may be dragging a tab).",
      );
    },
  });
  await assert.rejects(
    run("captureFullPage({id: 1, windowId: 2})"),
    (error) => {
      assert.equal(error.transientTab, true);
      assert.equal(error.diagnostic?.reason, "tab-strip-busy");
      assert.equal(error.diagnostic?.operation, "captureVisibleTab");
      assert.equal(error.diagnostic?.attempts, 5);
      return true;
    },
  );
  assert.equal(attempts, 5);
  assert.ok(state.restored && state.disconnected);
});

for (const [height, viewport, scale] of [
  [2350, 800, 1],
  [1600, 800, 2],
  [800, 800, 1],
  [2351, 800, 1.25],
  [2351, 800, 1.5],
  [2401, 801, 1001 / 801],
]) {
  test(`every document row appears once: ${height}/${viewport}, scale ${scale}`, async () => {
    const { run, state } = harness({ height, viewport, scale });
    await run("captureFullPage({id: 1, windowId: 2})");
    const canvas = state.canvases.at(-1);
    assert.equal(canvas.height, Math.round(height * scale));
    assert.equal(canvas.rows.length, canvas.height);
    for (let row = 0; row < canvas.height; row++)
      assert.equal(canvas.rows[row], row);
    assert.ok(state.restored && state.disconnected);
  });
}

test("single traversal follows content appended at the old bottom", async () => {
  let grew = false;
  const { run, state } = harness({
    onMessage(state, message) {
      if (!grew && message.minimumWait === 1500) {
        state.height += 900;
        grew = true;
      }
    },
  });
  await run("captureFullPage({id: 1, windowId: 2})");
  assert.equal(state.canvases.at(-1).height, 3250);
  assert.equal(state.canvases.at(-1).rows.at(-1), 3249);
  assert.equal(state.events[0].type, "capture", "No preparation traversal");
  for (let i = 1; i < state.events.length; i++) {
    assert.ok(
      state.events[i].y >= state.events[i - 1].y,
      "Never return to the top",
    );
  }
});

test("late growth retries only the current position and preserves previous rows", async () => {
  let grew = false;
  const { run, state } = harness({
    onCapture(state) {
      if (!grew && state.captures.length === 2) {
        state.height += 250;
        grew = true;
      }
    },
  });
  await run("captureFullPage({id: 1, windowId: 2})");
  assert.equal(state.canvases.length, 2);
  assert.equal(state.canvases.at(-1).rows.length, 2600);
  state.canvases.at(-1).rows.forEach((value, row) => assert.equal(value, row));
  assert.equal(
    state.events.filter((e) => e.type === "capture" && e.y === 0).length,
    1,
  );
});

test("failure during start still restores the page", async () => {
  const { run, state } = harness({
    onMessage(_state, message) {
      if (message.type === "fullPageCapture:start")
        throw new Error("start failed");
    },
  });
  await assert.rejects(
    run("captureFullPage({id: 1, windowId: 2})"),
    /start failed/,
  );
  assert.ok(state.restored && state.disconnected);
});

test("a stuck scroller fails without returning a partial screenshot", async () => {
  const { run, state } = harness({
    onMessage(state, message) {
      if (message.type === "fullPageCapture:scroll") state.y = 0;
    },
  });
  await assert.rejects(
    run("captureFullPage({id: 1, windowId: 2})"),
    /scrolled any farther/,
  );
  assert.equal(state.captures.length, 2);
  assert.ok(state.restored);
});

for (const height of [3400, 3399]) {
  test(`Wikipedia Retina bottom clamp preserves all 6799 rows (reported height ${height})`, async () => {
    // Measured at 100% zoom: body.scrollHeight=3400, root.scrollHeight=3399,
    // innerHeight=1281, DPR=2, but Chrome's actual last scrollY is 2118.5.
    const { run, state } = harness({ height, viewport: 1281, scale: 2, scrollLimit: 2118.5 });
    await run("captureFullPage({id: 1, windowId: 2})");
    const canvas = state.canvases.at(-1);
    assert.equal(canvas.height, 6799, "Extent comes from the actual bottom screenshot");
    assert.equal(canvas.rows.length, 6799);
    canvas.rows.forEach((value, row) => assert.equal(value, row));
    assert.ok(state.restored && state.disconnected);
  });
}

test("fractional DPR uses the true scale despite a rounded viewport screenshot", async () => {
  const { run, state } = harness({ height: 4001, viewport: 801, scale: 1.25, scrollLimit: 3200.8, scrollQuantum: 0.8 });
  await run("captureFullPage({id: 1, windowId: 2})");
  const canvas = state.canvases.at(-1);
  assert.equal(canvas.height, 5002);
  assert.equal(canvas.rows.length, canvas.height);
  canvas.rows.forEach((value, row) => assert.equal(value, row));
});

test("rounded scroll positions retain overlap without omitting or duplicating rows", async () => {
  const { run, state } = harness({ height: 2410, viewport: 801, scale: 1, scrollQuantum: 2 });
  await run("captureFullPage({id: 1, windowId: 2})");
  const canvas = state.canvases.at(-1);
  assert.equal(canvas.rows.length, 2410);
  canvas.rows.forEach((value, row) => assert.equal(value, row));
});

test("a genuine gap is rejected even on the final overlapping segment", async () => {
  const { run, state } = harness({ height: 1700, onMessage(state, message) {
    if (message.type === "fullPageCapture:scroll") state.y = 900;
  } });
  await assert.rejects(run("captureFullPage({id: 1, windowId: 2})"), /scrolled any farther/);
  assert.ok(state.restored && state.disconnected);
});

test("a scroller blocked before its real bottom cannot return a partial screenshot", async () => {
  const { run, state } = harness({ height: 2400, scrollLimit: 1500 });
  await assert.rejects(run("captureFullPage({id: 1, windowId: 2})"), /scrolled any farther/);
  assert.ok(state.restored && state.disconnected);
});

test("continually changing captures stop after bounded retries at the same position", async () => {
  const { run, state } = harness({
    onCapture(state) {
      state.height += 10;
    },
  });
  await assert.rejects(
    run("captureFullPage({id: 1, windowId: 2})"),
    /keeps changing/,
  );
  assert.equal(state.captures.length, 3);
  assert.ok(state.restored);
});

test("dynamic height shrink above covered rows succeeds in a single pass without aborting", async () => {
  let shrank = false;
  let starts = 0;
  const { run, state } = harness({
    height: 2350,
    onMessage(state, message) {
      if (message.type === "fullPageCapture:start") starts++;
      if (!shrank && message.type === "fullPageCapture:scroll") {
        // Simulates collapsing skeletons, virtualized list height refinement, or scroll-fixed header.
        state.height = 1800;
        shrank = true;
      }
    },
  });
  await run("captureFullPage({id: 1, windowId: 2})");
  assert.equal(starts, 1, "did not abort or restart needlessly");
  const canvas = state.canvases.at(-1);
  assert.equal(canvas.height, 1800);
  assert.equal(canvas.rows.length, 1800);
  for (let row = 0; row < 1800; row++) assert.equal(canvas.rows[row], row);
  assert.ok(state.restored && state.disconnected);
});

test("height shrinking down to already-covered bottom completes without false stuck-scroller error", async () => {
  let shrank = false;
  const { run, state } = harness({
    height: 2000,
    viewport: 800,
    onMessage(state, message) {
      if (!shrank && message.type === "fullPageCapture:scroll") {
        state.height = 800;
        state.y = 0;
        shrank = true;
      }
    },
  });
  await run("captureFullPage({id: 1, windowId: 2})");
  const canvas = state.canvases.at(-1);
  assert.equal(canvas.height, 800);
  assert.equal(canvas.rows.length, 800);
  for (let row = 0; row < 800; row++) assert.equal(canvas.rows[row], row);
  assert.ok(state.restored && state.disconnected);
});

test("height collapsing below already-covered rows recovers cleanly on retry", async () => {
  let collapsed = false;
  let starts = 0;
  let scrolls = 0;
  const { run, state } = harness({
    height: 2400,
    viewport: 800,
    onMessage(state, message) {
      if (message.type === "fullPageCapture:start") starts++;
      if (!collapsed && message.type === "fullPageCapture:scroll") {
        scrolls++;
        if (scrolls === 2) {
          state.height = 1200;
          state.y = 400;
          collapsed = true;
        }
      }
    },
  });
  await run("captureFullPage({id: 1, windowId: 2})");
  assert.equal(starts, 2, "restarted cleanly after height collapsed below covered pixels");
  const canvas = state.canvases.at(-1);
  assert.equal(canvas.height, 1200);
  assert.equal(canvas.rows.length, 1200);
  for (let row = 0; row < 1200; row++) assert.equal(canvas.rows[row], row);
  assert.ok(state.restored && state.disconnected);
});

test("subpixel crop jitter (<= 0.5px) does not trigger false layout retries", async () => {
  let starts = 0;
  const crop = { x: 0, y: 0, width: 80, height: 800 };
  const { run, state } = harness({
    height: 1600,
    crop,
    onMessage(_state, message) {
      if (message.type === "fullPageCapture:start") starts++;
      if (message.type === "fullPageCapture:scroll") {
        crop.x = 0.25;
        crop.y = 0.4;
      }
    },
  });
  await run("captureFullPage({id: 1, windowId: 2})");
  assert.equal(starts, 1, "subpixel jitter tolerated without retrying");
  assert.equal(state.canvases.at(-1).rows.length, 1600);
});

test("transient viewport/crop shift recovers automatically without corrupted seams", async () => {
  let shifted = false;
  let starts = 0;
  const crop = { x: 0, y: 0, width: 80, height: 800 };
  const { run, state } = harness({
    height: 1600,
    crop,
    onMessage(_state, message) {
      if (message.type === "fullPageCapture:start") starts++;
      if (!shifted && message.type === "fullPageCapture:scroll") {
        crop.x = 12;
        shifted = true;
      }
    },
  });
  await run("captureFullPage({id: 1, windowId: 2})");
  assert.equal(starts, 2, "restarted cleanly once after crop shifted");
  const canvas = state.canvases.at(-1);
  assert.equal(canvas.rows.length, 1600);
  for (let row = 0; row < 1600; row++) assert.equal(canvas.rows[row], row);
  assert.ok(state.restored && state.disconnected);
});

test("persistent layout instability stops after bounded retries and attaches structured diagnostics", async () => {
  let starts = 0;
  const crop = { x: 0, y: 0, width: 70, height: 800 };
  const { run, state } = harness({
    height: 2400,
    crop,
    onMessage(_state, message) {
      if (message.type === "fullPageCapture:start") {
        starts++;
        crop.x = 0;
      }
      if (message.type === "fullPageCapture:scroll") {
        crop.x = 15;
      }
    },
  });
  await assert.rejects(
    run("captureFullPage({id: 1, windowId: 2})"),
    (error) => {
      assert.match(error.message, /layout changed/);
      assert.equal(error.diagnostic?.reason, "geometry-changed");
      assert.equal(error.diagnostic?.attempt, 3);
      assert.ok(
        error.diagnostic?.diffs?.some((diff) => diff.includes("crop.x: 0 -> 15")),
      );
      return true;
    },
  );
  assert.equal(starts, 3, "1 initial pass + 2 bounded recovery passes");
  assert.ok(state.restored && state.disconnected);
});

test("internal scroller crops viewport offsets and stitches only main content", async () => {
  const { run, state } = harness({
    height: 1371,
    viewport: 400,
    windowHeight: 800,
    scale: 1.25,
    crop: { x: 20, y: 100, width: 70, height: 400 },
  });
  await run("captureFullPage({id: 1, windowId: 2})");
  const canvas = state.canvases.at(-1);
  assert.equal(canvas.width, 88);
  assert.equal(canvas.height, Math.round(1371 * 1.25));
  canvas.rows.forEach((value, row) => assert.equal(value, row));
  assert.equal(canvas.rows.length, canvas.height);
  assert.ok(state.restored);
});

test("oversized canvases report an error and restore state", async () => {
  const { run, state } = harness({ height: 40000 });
  await assert.rejects(
    run("captureFullPage({id: 1, windowId: 2})"),
    /too large/,
  );
  assert.ok(state.restored);
});

test("multiple areas are captured once each, then composed with the first app frame", async () => {
  const regions = [
    {
      height: 1550,
      viewport: 400,
      crop: { x: 30, y: 100, width: 70, height: 400 },
    },
    {
      height: 1000,
      viewport: 450,
      crop: { x: 0, y: 50, width: 20, height: 450 },
    },
  ];
  const { run, state } = harness({ ...regions[0], windowHeight: 800, regions });
  const result = await run("captureFullPage({id: 1, windowId: 2})");
  assert.equal(result.screenshot, "data:image/png;base64,composed");
  assert.equal(result.text, "Rendered text");
  assert.equal(result.title, "Test page");
  assert.equal(state.composed.panels.length, 2);
  for (let index = 0; index < 2; index++) {
    const canvas = state.composed.panels[index].canvas;
    assert.equal(canvas.rows.length, regions[index].height);
    canvas.rows.forEach((value, row) => assert.equal(value, row));
    const events = state.events.filter((event) => event.region === index);
    assert.equal(
      events.filter((e) => e.type === "capture" && e.y === 0).length,
      1,
    );
    for (let i = 1; i < events.length; i++)
      assert.ok(events[i].y >= events[i - 1].y);
  }
  assert.equal(state.composed.shell.top, -100);
  assert.ok(state.restored && state.disconnected);
});

test("restricted and unsupported URL detection handles browser schemes and Web Store account routes", () => {
  const { run } = harness();
  const isProtected = (url) => run(`isProtectedPageUrl(${JSON.stringify(url)})`);
  const isUnsupported = (url) =>
    run(`isUnsupportedPageUrl(${JSON.stringify(url)})`);

  for (const url of [
    "chrome://extensions",
    "chrome-extension://abcdefghijklmnop/sidepanel.html",
    "chrome-untrusted://crosh/",
    "devtools://devtools/bundled/inspector.html",
    "about:blank",
    "view-source:https://example.com/",
    "https://chromewebstore.google.com",
    "https://chromewebstore.google.com/detail/pagerelay/abc",
    "https://chromewebstore.google.com/u/1/detail/pagerelay/abc",
    "https://chrome.google.com/webstore",
    "https://chrome.google.com/webstore/devconsole/123",
    "https://chrome.google.com/u/0/webstore/devconsole/123",
    "https://chrome.google.com/u/2/webstore/devconsole/xyz/items",
  ]) {
    assert.equal(isProtected(url), true, `expected restricted: ${url}`);
    assert.equal(isUnsupported(url), false, `not unsupported scheme: ${url}`);
  }

  for (const url of [
    "data:text/html,<h1>Test</h1>",
    "blob:https://example.com/550e8400-e29b-41d4-a716-446655440000",
    "javascript:void(0)",
  ]) {
    assert.equal(isProtected(url), false, `not browser-restricted: ${url}`);
    assert.equal(isUnsupported(url), true, `expected unsupported: ${url}`);
  }

  for (const url of [
    "https://github.com/org/repo",
    "https://apps.admob.com/v2/home",
    "https://chromewebstore.google.com.evil.test/",
    "https://chrome.google.com/webstore-blog/post",
    "file:///tmp/example.html",
  ]) {
    assert.equal(isProtected(url), false, `regular page allowed: ${url}`);
    assert.equal(isUnsupported(url), false, `regular page supported: ${url}`);
  }
});

test("geometry comparison allows lazy height growth but rejects crop/viewport movement", () => {
  const { run } = harness();
  const geometry = {
    viewportHeight: 400,
    viewportWidth: 70,
    windowHeight: 800,
    windowWidth: 100,
    documentHeight: 2000,
    scrollX: 0,
    scrollY: 0,
    crop: { x: 30, y: 100, width: 70, height: 400 },
  };
  const compare = (fn, other) =>
    run(`${fn}(${JSON.stringify(geometry)}, ${JSON.stringify(other)})`);
  assert.ok(compare("sameGeometry", { ...geometry, documentHeight: 2500 }));
  assert.equal(
    compare("sameViewport", { ...geometry, documentHeight: 2500 }),
    false,
  );
  for (const key of [
    "viewportHeight",
    "viewportWidth",
    "windowHeight",
    "windowWidth",
  ]) {
    assert.equal(
      compare("sameGeometry", { ...geometry, [key]: geometry[key] + 1 }),
      false,
    );
  }
  assert.equal(
    compare("sameGeometry", { ...geometry, crop: { ...geometry.crop, x: 31 } }),
    false,
  );
  assert.equal(compare("sameViewport", { ...geometry, scrollY: 400 }), false);
});

function pageHarness({
  imageReadyAt = 900,
  fontsReadyAt = 1200,
  continuousMutations = false,
} = {}) {
  const state = { time: 0, scrollX: 12, scrollY: 177 };
  const windowListeners = new Map();
  const documentListeners = new Map();
  const makeEmitter = (map) => ({
    addEventListener(type, fn) {
      if (!map.has(type)) map.set(type, new Set());
      map.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      map.get(type)?.delete(fn);
    },
    emit(type, event) {
      for (const fn of [...(map.get(type) || [])]) fn(event);
    },
  });
  const winEmitter = makeEmitter(windowListeners);
  const docEmitter = makeEmitter(documentListeners);
  function element() {
    const properties = new Map();
    return {
      scrollHeight: 2000,
      offsetHeight: 2000,
      clientHeight: 800,
      clientWidth: 100,
      style: {
        [Symbol.iterator]: () => properties.keys(),
        getPropertyValue: (key) => properties.get(key)?.value || "",
        getPropertyPriority: (key) => properties.get(key)?.priority || "",
        setProperty: (key, value, priority) =>
          properties.set(key, { value, priority }),
        removeProperty: (key) => properties.delete(key),
      },
    };
  }
  const root = element();
  const body = element();
  let handler;
  let connection;
  let observerCallback;
  const window = {
    ...state,
    innerWidth: 100,
    innerHeight: 800,
    addEventListener: winEmitter.addEventListener,
    removeEventListener: winEmitter.removeEventListener,
    scrollTo({ left, top }) {
      this.scrollX = left;
      this.scrollY = top;
      docEmitter.emit("scroll", { target: document });
    },
  };
  const document = {
    documentElement: root,
    body,
    addEventListener: docEmitter.addEventListener,
    removeEventListener: docEmitter.removeEventListener,
    querySelectorAll: () => [root, body],
    fonts: {
      get status() {
        return state.time < fontsReadyAt ? "loading" : "loaded";
      },
    },
    images: [
      {
        get complete() {
          return state.time >= imageReadyAt;
        },
        getBoundingClientRect: () => ({
          top: 0,
          bottom: 100,
          left: 0,
          right: 100,
        }),
      },
    ],
  };
  const context = vm.createContext({
    window,
    PageTextCollector: class {
      sample() {}
      stats() {
        return { characters: 0, estimatedTokens: 0 };
      }
    },
    innerWidth: 100,
    innerHeight: 800,
    performance: { now: () => state.time },
    setTimeout: (callback, ms) => {
      state.time += ms;
      if (continuousMutations) observerCallback?.();
      queueMicrotask(callback);
    },
    getComputedStyle: () => ({ position: "static" }),
    MutationObserver: class {
      constructor(cb) {
        observerCallback = cb;
      }
      observe() {}
      disconnect() {}
    },
    document,
    chrome: {
      runtime: {
        onMessage: {
          addListener(fn) {
            handler = fn;
          },
        },
        onConnect: {
          addListener(fn) {
            connection = fn;
          },
        },
      },
    },
  });
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, "../content.js"), "utf8"),
    context,
  );
  const send = (action, extra = {}) =>
    new Promise((resolve, reject) =>
      handler({ type: `fullPageCapture:${action}`, ...extra }, {}, (response) => {
        if (response.ok) resolve(response.result);
        else {
          const error = new Error(response.error);
          if (response.code) error.code = response.code;
          if (response.detail) error.detail = response.detail;
          reject(error);
        }
      }),
    );
  let disconnect;
  connection({
    name: "fullPageCapture",
    onDisconnect: {
      addListener(fn) {
        disconnect = fn;
      },
    },
  });
  return {
    state,
    root,
    window,
    document,
    emitWindow: winEmitter.emit,
    emitDocument: docEmitter.emit,
    listenerCount: () =>
      [...windowListeners.values(), ...documentListeners.values()].reduce(
        (sum, set) => sum + set.size,
        0,
      ),
    send,
    disconnect: () => disconnect(),
  };
}

test("content script waits for visible images, fonts and a quiet interval", async () => {
  const { send, state, root, window } = pageHarness();
  await send("start");
  assert.ok(
    state.time >= 900 + QUIET_MS,
    "Waits for the pending visible image and the quiet interval",
  );
  assert.ok(state.time >= 1200, "Waits for document fonts");
  assert.equal(window.scrollY, 0);
  await send("restore");
  assert.equal(window.scrollY, 177);
  assert.equal(window.scrollX, 12);
  assert.equal(root.style.getPropertyValue("scroll-behavior"), "");
});

test("a visible image that never finishes produces a bounded error", async () => {
  const { send, state, window } = pageHarness({ imageReadyAt: Infinity });
  await assert.rejects(send("start"), /still loading/);
  assert.equal(state.time, 5000);
  await send("restore");
  assert.equal(window.scrollY, 177);
});

test("closing the panel during a wait cancels work and restores styles", async () => {
  const { send, disconnect, window, root } = pageHarness();
  const pending = send("start");
  disconnect();
  await assert.rejects(pending, /cancelled/);
  assert.equal(window.scrollY, 177);
  assert.equal(root.style.getPropertyValue("scroll-snap-type"), "");
});

test("continuous non-layout DOM mutations settle cleanly once layout and resources stabilize", async () => {
  const { send, state } = pageHarness({
    imageReadyAt: 200,
    fontsReadyAt: 200,
    continuousMutations: true,
  });
  await send("start");
  assert.ok(
    state.time >= 1000 && state.time < 2000,
    `expected bounded layout-stable settle, got ${state.time}ms`,
  );
  await send("restore");
});

test("manual wheel, keyboard, and scrollbar scrolling interrupt capture cleanly without false positives", async () => {
  for (const [kind, trigger] of [
    [
      "wheel",
      (h) => {
        h.emitWindow("wheel", { isTrusted: true, deltaY: 120, deltaX: 0 });
        h.window.scrollY = 180;
        h.emitDocument("scroll", { target: h.document });
      },
    ],
    [
      "keydown",
      (h) => {
        h.emitWindow("keydown", {
          isTrusted: true,
          key: "PageDown",
          target: h.document.body,
        });
        h.window.scrollY = 400;
        h.emitDocument("scroll", { target: h.document });
      },
    ],
    [
      "scrollbar",
      (h) => {
        h.emitWindow("pointerdown", {
          isTrusted: true,
          clientX: 99,
          clientY: 200,
        });
        h.window.scrollY = 300;
        h.emitDocument("scroll", { target: h.document });
      },
    ],
  ]) {
    const h = pageHarness({ imageReadyAt: 0, fontsReadyAt: 0 });
    await h.send("start");
    assert.ok(h.listenerCount() > 0, "passive scroll listeners installed during capture");
    trigger(h);
    await assert.rejects(
      h.send("measure"),
      (error) =>
        error.code === "USER_SCROLL_INTERRUPTED" &&
        error.detail === kind &&
        /manually scrolled/i.test(error.message),
    );
    await h.send("restore");
    assert.equal(h.listenerCount(), 0, "scroll listeners cleaned up after restore");
  }

  // Programmatic scrolls, untrusted events, or wheel input without scroll movement do not trigger false interruptions.
  const h = pageHarness({ imageReadyAt: 0, fontsReadyAt: 0 });
  await h.send("start");
  await h.send("scroll", { scrollY: 600 });
  h.emitWindow("wheel", { isTrusted: false, deltaY: 100, deltaX: 0 });
  h.window.scrollY = 650;
  h.emitDocument("scroll", { target: h.document });
  await h.send("measure");
  h.emitWindow("wheel", { isTrusted: true, deltaY: -100, deltaX: 0 });
  await h.send("scroll", { scrollY: 900 });
  await h.send("restore");
  assert.equal(h.listenerCount(), 0);
});

test("manual scroll interruption does not trigger layout retries in captureFullPage", async () => {
  let starts = 0;
  const { run, state } = harness({
    height: 2400,
    onMessage(_state, message) {
      if (message.type === "fullPageCapture:start") starts++;
      if (message.type === "fullPageCapture:scroll") {
        const error = new Error("The page was manually scrolled during capture.");
        error.interrupted = true;
        error.interruptionReason = "manual-scroll";
        error.expected = true;
        throw error;
      }
    },
  });
  await assert.rejects(
    run("captureFullPage({id: 1, windowId: 2})"),
    (error) => error.interrupted === true && error.interruptionReason === "manual-scroll",
  );
  assert.equal(starts, 1, "manual scroll interruption fails fast without retrying");
  assert.ok(state.restored && state.disconnected);
});
