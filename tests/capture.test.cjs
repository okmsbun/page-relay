const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "../popup.js"), "utf8");

// A fake capture contains its document pixel row numbers. Stitching must preserve
// every row exactly once, even when the browser clamps the last scroll position.
function harness({
  height = 2350,
  viewport = 800,
  scale = 1,
  crop = { x: 0, y: 0, width: 100, height: viewport },
  windowHeight = viewport,
  regions,
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
    crop,
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
      getElementById: () => ({ style: {}, addEventListener() {}, setAttribute() {} }),
      createElement() {
        const canvas = {
          rows: [],
          getContext: () => ({
            drawImage(image, sx, sy, sw, sh, dx, dy, dw, dh) {
              if (image.rows) {
                canvas.rows = image.rows.slice();
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
        query: async () => [{ id: 1, windowId: 2 }],
        sendMessage: async (_tab, message, options) => {
          assert.equal(options.frameId, 0);
          if (message.type === "fullPageCapture:select") {
            state.regionIndex = message.index;
            ({ viewport, crop } = regions[message.index]);
            state.height = regions[message.index].height;
            state.y = 0;
          }
          if (message.type === "fullPageCapture:scroll") {
            state.y = Math.max(
              0,
              Math.min(message.scrollY, state.height - viewport),
            );
            state.events.push({ type: "scroll", y: state.y, region: state.regionIndex });
          }
          if (message.type === "fullPageCapture:start") state.y = 0;
          if (message.type === "fullPageCapture:restore") state.restored = true;
          await onMessage?.(state, message);
          return { ok: true, result: metrics() };
        },
        captureVisibleTab: async () => {
          const previous = state.captures.at(-1);
          if (previous)
            assert.ok(state.time - previous.time >= 650, "Capture throttle");
          const shot = {
            top: Math.round(state.y * scale) - Math.round(crop.y * scale),
            time: state.time,
            height: Math.round(windowHeight * scale),
            width: Math.round(100 * scale),
          };
          state.captures.push(shot);
          state.events.push({ type: "capture", y: state.y, region: state.regionIndex });
          await onCapture?.(state);
          return JSON.stringify(shot);
        },
      },
    },
  });
  vm.runInContext(source, context);
  return { state, run: (expression) => vm.runInContext(expression, context) };
}

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
    { height: 1550, viewport: 400, crop: { x: 30, y: 100, width: 70, height: 400 } },
    { height: 1000, viewport: 450, crop: { x: 0, y: 50, width: 20, height: 450 } },
  ];
  const { run, state } = harness({ ...regions[0], windowHeight: 800, regions });
  assert.equal(await run("captureFullPage({id: 1, windowId: 2})"), "data:image/png;base64,composed");
  assert.equal(state.composed.panels.length, 2);
  for (let index = 0; index < 2; index++) {
    const canvas = state.composed.panels[index].canvas;
    assert.equal(canvas.rows.length, regions[index].height);
    canvas.rows.forEach((value, row) => assert.equal(value, row));
    const events = state.events.filter((event) => event.region === index);
    assert.equal(events.filter((e) => e.type === "capture" && e.y === 0).length, 1);
    for (let i = 1; i < events.length; i++) assert.ok(events[i].y >= events[i - 1].y);
  }
  assert.equal(state.composed.shell.top, -100);
  assert.ok(state.restored && state.disconnected);
});

test("geometry comparison allows lazy height growth but rejects crop/viewport movement", () => {
  const { run } = harness();
  const geometry = { viewportHeight: 400, viewportWidth: 70, windowHeight: 800, windowWidth: 100,
    documentHeight: 2000, scrollX: 0, scrollY: 0, crop: { x: 30, y: 100, width: 70, height: 400 } };
  const compare = (fn, other) => run(`${fn}(${JSON.stringify(geometry)}, ${JSON.stringify(other)})`);
  assert.ok(compare("sameGeometry", { ...geometry, documentHeight: 2500 }));
  assert.equal(compare("sameViewport", { ...geometry, documentHeight: 2500 }), false);
  for (const key of ["viewportHeight", "viewportWidth", "windowHeight", "windowWidth"]) {
    assert.equal(compare("sameGeometry", { ...geometry, [key]: geometry[key] + 1 }), false);
  }
  assert.equal(compare("sameGeometry", { ...geometry, crop: { ...geometry.crop, x: 31 } }), false);
  assert.equal(compare("sameViewport", { ...geometry, scrollY: 400 }), false);
});

function pageHarness({ imageReadyAt = 900, fontsReadyAt = 1200 } = {}) {
  const state = { time: 0, scrollX: 12, scrollY: 177 };
  function element() {
    const properties = new Map();
    return {
      scrollHeight: 2000,
      offsetHeight: 2000,
      clientHeight: 800,
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
  const window = {
    ...state,
    innerWidth: 100,
    innerHeight: 800,
    scrollTo({ left, top }) {
      this.scrollX = left;
      this.scrollY = top;
    },
  };
  const context = vm.createContext({
    window,
    innerWidth: 100,
    innerHeight: 800,
    performance: { now: () => state.time },
    setTimeout: (callback, ms) => {
      state.time += ms;
      queueMicrotask(callback);
    },
    getComputedStyle: () => ({ position: "static" }),
    MutationObserver: class {
      observe() {}
      disconnect() {}
    },
    document: {
      documentElement: root,
      body,
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
    },
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
  const send = (action) =>
    new Promise((resolve, reject) =>
      handler({ type: `fullPageCapture:${action}` }, {}, (response) =>
        response.ok
          ? resolve(response.result)
          : reject(new Error(response.error)),
      ),
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
  return { state, root, window, send, disconnect: () => disconnect() };
}

test("content script waits for visible images, fonts and a quiet interval", async () => {
  const { send, state, root, window } = pageHarness();
  await send("start");
  assert.ok(
    state.time >= 1500,
    "Does not capture pending resources after only 150 ms",
  );
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

test("closing the popup during a wait cancels work and restores styles", async () => {
  const { send, disconnect, window, root } = pageHarness();
  const pending = send("start");
  disconnect();
  await assert.rejects(pending, /cancelled/);
  assert.equal(window.scrollY, 177);
  assert.equal(root.style.getPropertyValue("scroll-snap-type"), "");
});
