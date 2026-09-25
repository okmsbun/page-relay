// Real Chrome captureVisibleTab + native Side Panel, in an isolated headless profile.
// The fractional-height document reproduces Wikipedia's rounded body/root scroll
// extents. Each screenshot row encodes its index so seams cannot hide omitted,
// repeated, rescaled or blank pixels. No accounts or visible windows are used.
const assert = require("node:assert/strict");
const http = require("node:http");
const { launch, waitFor, PANEL_STATE } = require("./sidepanel-e2e.cjs");

const html = `<!doctype html><html><head><title>Capture row regression</title>
<style>html,body{height:100%;margin:0}canvas{display:block}</style></head>
<body><canvas id="rows"></canvas><script>
const canvas = document.getElementById('rows'), dpr = devicePixelRatio;
canvas.width = Math.round(80*dpr); canvas.height = Math.round(3399.5*dpr);
canvas.style.width = '80px'; canvas.style.height = canvas.height/dpr+'px';
const ctx = canvas.getContext('2d'), data = ctx.createImageData(canvas.width,canvas.height);
for(let y=0;y<canvas.height;y++) for(let x=0;x<canvas.width;x++) {
 const i=(y*canvas.width+x)*4;
 data.data.set([y%256,Math.floor(y/256),37,255],i);
}
ctx.putImageData(data,0,0);
</script></body></html>`;

async function check(url, dpr) {
  const browser = await launch(url, {
    headless: true, deviceScaleFactor: dpr, windowSize: "1400,896",
    ...(process.env.EXTENSION_DIR ? { extensionPath: process.env.EXTENSION_DIR } : {}),
  });
  const { cdp, extensionId } = browser;
  try {
    const target = await waitFor("fixture tab", async () =>
      (await cdp.targets()).find((t) => t.type === "tab" && t.url === url));
    const worker = await waitFor("extension worker", async () =>
      (await cdp.targets()).find((t) => t.url === `chrome-extension://${extensionId}/service-worker.js`));
    const sw = await cdp.attach(worker.targetId);
    const source = await waitFor("fixture loaded", () => cdp.evaluate(sw,
      `(async () => (await chrome.tabs.query({})).find(t=>t.url===${JSON.stringify(url)} && t.status==='complete'))()`));
    await cdp.send("Extensions.triggerAction", { id: extensionId, targetId: target.targetId });
    const panel = await waitFor("native Side Panel", async () =>
      (await cdp.targets()).find((t) => t.url === `chrome-extension://${extensionId}/sidepanel.html`));
    const session = await cdp.attach(panel.targetId);
    const result = await waitFor("capture completion", async () => {
      const state = await cdp.evaluate(session, PANEL_STATE);
      return ["success", "error"].includes(state.state) && state;
    });
    assert.equal(result.state, "success", `DPR ${dpr}: ${result.detail}`);
    const [{ result: original }] = await cdp.evaluate(sw,
      `chrome.scripting.executeScript({target:{tabId:${source.id}},func:()=>({
        height:document.getElementById('rows').height, dpr:devicePixelRatio,
        root:document.documentElement.scrollHeight, body:document.body.scrollHeight, y:scrollY})})`);
    const pixels = await cdp.evaluate(session, `(() => {
      const image = document.getElementById('preview');
      const canvas = document.createElement('canvas');
      canvas.width=1; canvas.height=image.naturalHeight;
      const ctx=canvas.getContext('2d');
      ctx.drawImage(image,20,0,1,image.naturalHeight,0,0,1,image.naturalHeight);
      const data=ctx.getImageData(0,0,1,canvas.height).data;
      const errors=[];
      for(let y=0;y<canvas.height;y++) {
        const actual=Array.from(data.slice(y*4,y*4+4));
        if(actual.join(',') !== [y%256,Math.floor(y/256),37,255].join(',')) {
          errors.push({y,actual}); if(errors.length===5) break;
        }
      }
      return {height:canvas.height,errors};
    })()`);
    assert.equal(pixels.height, original.height, "All original raster rows captured");
    assert.deepEqual(pixels.errors, [], "Every output pixel row appears exactly once");
    assert.equal(original.y, 0, "Source scroll position restored");
    console.log(`PASS real Chrome DPR ${original.dpr}: ${pixels.height} exact rows; root/body ${original.root}/${original.body}`);
  } finally {
    browser.close();
  }
}

async function main() {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(html);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}/`;
    for (const dpr of [2, 1.25]) await check(url, dpr);
  } finally {
    server.close();
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
