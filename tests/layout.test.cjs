const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

// Small pixel-labelled rasters let us test where every source row ends up.
function raster(width = 0, height = 0, pixel = () => null) {
  const bitmap = { width, height, pixels: Array.from({ length: height }, (_, y) =>
    Array.from({ length: width }, (_, x) => pixel(x, y))) };
  const put = (x, y, value) => { (bitmap.pixels[y] ||= [])[x] = value; };
  const context = {
    fillStyle: null,
    fillRect(x, y, w, h) {
      for (let row = y; row < y + h; row++) for (let col = x; col < x + w; col++) put(col, row, this.fillStyle);
    },
    drawImage(image, ...args) {
      const [sx, sy, sw, sh, dx, dy, dw, dh] = args.length === 2
        ? [0, 0, image.width, image.height, ...args, image.width, image.height] : args;
      assert.equal(sw, dw); assert.equal(sh, dh);
      for (let row = 0; row < dh; row++) for (let col = 0; col < dw; col++) {
        assert.ok(sy + row < image.height && sx + col < image.width);
        put(dx + col, dy + row, image.pixels[sy + row][sx + col]);
      }
    },
  };
  bitmap.getContext = () => context;
  return bitmap;
}

function compose(shell, panels, metrics) {
  const context = vm.createContext({ shell, panels, metrics,
    checkCanvasSize: (w, h) => { if (w * h > 100000) throw new Error("too large"); },
    document: { createElement: () => raster() },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../capture-layout.js"), "utf8"), context);
  return vm.runInContext("composeApplicationScreenshot(shell, panels, metrics)", context);
}

test("app frame, sidebar and main content each appear once at their original x positions", () => {
  const shell = raster(12, 10, (x, y) => `shell:${x}:${y}`);
  const sidebar = raster(3, 9, (_x, y) => `sidebar:${y}`);
  const main = raster(6, 14, (_x, y) => `main:${y}`);
  const result = compose(shell, [
    { canvas: main, crop: { x: 5, y: 2, width: 6, height: 6 }, background: "main-bg" },
    { canvas: sidebar, crop: { x: 0, y: 2, width: 3, height: 6 }, background: "side-bg" },
  ], { windowWidth: 12, windowHeight: 10, background: "app-bg" });
  assert.equal(result.width, 12); assert.equal(result.height, 18);
  for (let y = 0; y < 2; y++) assert.deepEqual(result.pixels[y], shell.pixels[y]);
  for (let y = 0; y < main.height; y++) assert.equal(result.pixels[y + 2][5], `main:${y}`);
  for (let y = 0; y < sidebar.height; y++) assert.equal(result.pixels[y + 2][1], `sidebar:${y}`);
  for (let y = 11; y < 16; y++) assert.equal(result.pixels[y][1], "side-bg");
  assert.deepEqual(result.pixels[16], shell.pixels[8]);
  assert.deepEqual(result.pixels[17], shell.pixels[9]);
  assert.equal(result.pixels.flat().filter((pixel) => pixel === "shell:0:0").length, 1);
});

test("single internal panel retains a non-scrolling sidebar and toolbar", () => {
  const shell = raster(12, 10, (x, y) => `shell:${x}:${y}`);
  const main = raster(6, 14, (_x, y) => `main:${y}`);
  const result = compose(shell, [
    { canvas: main, crop: { x: 5, y: 2, width: 6, height: 6 }, background: "main-bg" },
  ], { windowWidth: 12, windowHeight: 10, background: "app-bg" });
  for (let y = 0; y < 8; y++) assert.equal(result.pixels[y][1], `shell:1:${y}`);
  assert.equal(result.pixels.flat().filter((pixel) => pixel === "shell:1:4").length, 1);
});

test("vertically separate panels shift later rows and preserve intervening UI", () => {
  const shell = raster(10, 12, (x, y) => `shell:${x}:${y}`);
  const result = compose(shell, [
    { canvas: raster(8, 7, (_x, y) => `a:${y}`), crop: { x: 1, y: 1, width: 8, height: 3 } },
    { canvas: raster(8, 6, (_x, y) => `b:${y}`), crop: { x: 1, y: 6, width: 8, height: 4 } },
  ], { windowWidth: 10, windowHeight: 12 });
  assert.equal(result.height, 18);
  assert.equal(result.pixels[8][1], "shell:1:4");
  assert.equal(result.pixels[10][1], "b:0");
  assert.equal(result.pixels[15][1], "b:5");
  assert.equal(result.pixels[16][1], "shell:1:10");
});

test("Retina dimensions and offset panel footers remain pixel aligned", () => {
  const shell = raster(24, 20, (x, y) => `shell:${x}:${y}`);
  const result = compose(shell, [
    { canvas: raster(6, 18, (_x, y) => `side:${y}`), crop: { x: 0, y: 2, width: 3, height: 6 } },
    { canvas: raster(12, 28, (_x, y) => `main:${y}`), crop: { x: 5, y: 3, width: 6, height: 4 } },
  ], { windowWidth: 12, windowHeight: 10 });
  assert.equal(result.width, 24); assert.equal(result.height, 40);
  assert.equal(result.pixels[6][10], "main:0");
  assert.equal(result.pixels[33][10], "main:27");
  assert.equal(result.pixels[34][10], "shell:10:14");
  assert.equal(result.pixels[38][0], "shell:0:18");
});

test("stacked main panels do not overlap when a tall sidebar spans both rows", () => {
  const shell = raster(12, 12, (x, y) => `shell:${x}:${y}`);
  const result = compose(shell, [
    { canvas: raster(3, 18, (_x, y) => `side:${y}`), crop: { x: 0, y: 1, width: 3, height: 9 } },
    { canvas: raster(6, 7, (_x, y) => `a:${y}`), crop: { x: 5, y: 1, width: 6, height: 3 } },
    { canvas: raster(6, 5, (_x, y) => `b:${y}`), crop: { x: 5, y: 6, width: 6, height: 3 } },
  ], { windowWidth: 12, windowHeight: 12 });
  assert.equal(result.height, 21);
  for (let y = 0; y < 7; y++) assert.equal(result.pixels[y + 1][5], `a:${y}`);
  for (let y = 0; y < 5; y++) assert.equal(result.pixels[y + 10][5], `b:${y}`);
  for (let y = 0; y < 18; y++) assert.equal(result.pixels[y + 1][0], `side:${y}`);
  assert.equal(result.pixels[8][5], "shell:5:4");
  assert.equal(result.pixels[20][5], "shell:5:11");
});
