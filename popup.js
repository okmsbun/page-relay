const button = document.getElementById("takeScreenshot");
const preview = document.getElementById("preview");

const CAPTURE_INTERVAL_MS = 650;
const BOTTOM_WAIT_MS = 1500;
const MAX_CAPTURE_SEGMENTS = 200;
// Leave headroom for Chrome's canvas limits and memory, especially on Retina screens.
const MAX_CANVAS_SIDE = 32767;
const MAX_CANVAS_PIXELS = 64 * 1024 * 1024;
let lastCaptureTime = 0;
let capturedPage = null;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function sendToPage(tabId, message) {
  const response = await chrome.tabs.sendMessage(tabId, message, {
    frameId: 0,
  });
  if (!response?.ok) {
    throw new Error(response?.error || "The page did not respond.");
  }
  return response.result;
}

function loadImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () =>
      reject(new Error("A screenshot segment could not be read."));
    image.src = dataUrl;
  });
}

function sameGeometry(a, b) {
  return (
    a.viewportHeight === b.viewportHeight &&
    a.viewportWidth === b.viewportWidth &&
    a.windowHeight === b.windowHeight &&
    a.windowWidth === b.windowWidth &&
    ["x", "y", "width", "height"].every((key) => a.crop[key] === b.crop[key]) &&
    JSON.stringify((a.regions || []).map((r) => r.crop)) ===
      JSON.stringify((b.regions || []).map((r) => r.crop))
  );
}

function sameViewport(a, b) {
  return (
    sameGeometry(a, b) &&
    a.documentHeight === b.documentHeight &&
    a.scrollX === b.scrollX &&
    a.scrollY === b.scrollY
  );
}

function checkCanvasSize(width, height) {
  if (
    height > MAX_CANVAS_SIDE ||
    width > MAX_CANVAS_SIDE ||
    height * width > MAX_CANVAS_PIXELS
  ) {
    throw new Error(
      "This page is too large for a single PNG at this resolution.",
    );
  }
}

async function capturePass(tab, initial, session = { captures: 0 }) {
  let canvas = document.createElement("canvas");
  let context;
  let scaleY;
  let coveredPixels = 0;
  let requestedY = 0;
  let previousHeight = initial.documentHeight;
  let unstableCaptures = 0;

  for (let index = 0; index < MAX_CAPTURE_SEGMENTS; index++) {
    if (++session.captures > MAX_CAPTURE_SEGMENTS) {
      throw new Error("The page is too long to capture safely.");
    }
    showProgress(initial.regionIndex || 0, initial.regions?.length || 1,
      requestedY / previousHeight, index + 1);
    // start already moved to the top. Every subsequent move contributes pixels.
    let settled =
      index === 0
        ? initial
        : await sendToPage(tab.id, {
            type: "fullPageCapture:scroll",
            scrollY: requestedY,
          });
    await delay(
      Math.max(0, CAPTURE_INTERVAL_MS - (Date.now() - lastCaptureTime)),
    );
    let before = await sendToPage(tab.id, { type: "fullPageCapture:measure" });
    if (!sameViewport(settled, before)) {
      before = await sendToPage(tab.id, { type: "fullPageCapture:settle" });
    }
    if (before.scrollY + before.viewportHeight >= before.documentHeight - 1) {
      // Wait at the bottom before saving it: lazy-loaded rows may extend the page.
      before = await sendToPage(tab.id, {
        type: "fullPageCapture:settle",
        minimumWait: BOTTOM_WAIT_MS,
      });
    }
    if (
      !sameGeometry(initial, before) ||
      before.documentHeight < previousHeight
    ) {
      throw new Error(
        "The page layout changed during capture. Wait for it to settle and retry.",
      );
    }

    const [activeTab] = await chrome.tabs.query({
      active: true,
      windowId: tab.windowId,
    });
    if (activeTab?.id !== tab.id)
      throw new Error("Keep the captured tab active.");
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
      format: "png",
    });
    lastCaptureTime = Date.now();
    const after = await sendToPage(tab.id, { type: "fullPageCapture:measure" });
    showTextStats(after.textStats);
    if (!sameViewport(before, after)) {
      // Retry this position only; never start another full-page traversal.
      if (++unstableCaptures >= 3) {
        throw new Error(
          "The page keeps changing during capture. Please wait and retry.",
        );
      }
      requestedY = before.scrollY;
      continue;
    }
    unstableCaptures = 0;
    const image = await loadImage(dataUrl);
    if (!session.shell && initial.regions?.length) session.shell = image;
    // captureVisibleTab returns the whole browser viewport, even for an element.
    const pixelX = image.width / before.windowWidth;
    const pixelY = image.height / before.windowHeight;
    const cropX = Math.round(before.crop.x * pixelX);
    const cropY = Math.round(before.crop.y * pixelY);
    const cropWidth =
      Math.round((before.crop.x + before.crop.width) * pixelX) - cropX;
    const cropHeight =
      Math.round((before.crop.y + before.crop.height) * pixelY) - cropY;
    if (cropWidth <= 0 || cropHeight <= 0)
      throw new Error("The scrolling area is not visible.");

    if (!context) {
      scaleY = cropHeight / before.viewportHeight;
      const height = Math.round(before.documentHeight * scaleY);
      checkCanvasSize(cropWidth, height);
      canvas.width = cropWidth;
      canvas.height = height;
      context = canvas.getContext("2d");
      if (!context)
        throw new Error("Could not allocate the screenshot canvas.");
    } else if (
      cropWidth !== canvas.width ||
      cropHeight !== Math.round(before.viewportHeight * scaleY)
    ) {
      throw new Error(
        "The viewport size changed during capture. Please retry.",
      );
    }

    const height = Math.round(before.documentHeight * scaleY);
    if (height !== canvas.height) {
      checkCanvasSize(canvas.width, height);
      // Preserve already captured rows when lazy content increases scrollHeight.
      const expanded = document.createElement("canvas");
      expanded.width = canvas.width;
      expanded.height = height;
      const expandedContext = expanded.getContext("2d");
      if (!expandedContext)
        throw new Error("Could not expand the screenshot canvas.");
      expandedContext.drawImage(canvas, 0, 0);
      canvas.width = canvas.height = 0;
      canvas = expanded;
      context = expandedContext;
    }
    previousHeight = before.documentHeight;

    // Shared integer boundaries keep fractional DPR/zoom and the last crop aligned.
    const segmentTop = Math.round(before.scrollY * scaleY);
    const segmentBottom = Math.min(canvas.height, segmentTop + cropHeight);
    if (segmentTop > coveredPixels || segmentBottom <= coveredPixels) {
      throw new Error(
        "The page could not be scrolled any farther without missing screenshot sections.",
      );
    }
    const sourceY = coveredPixels - segmentTop;
    const rows = segmentBottom - coveredPixels;
    context.drawImage(
      image,
      cropX,
      cropY + sourceY,
      cropWidth,
      rows,
      0,
      coveredPixels,
      canvas.width,
      rows,
    );
    coveredPixels = segmentBottom;

    if (coveredPixels === canvas.height) {
      return canvas;
    }
    requestedY = Math.min(
      coveredPixels / scaleY,
      before.documentHeight - before.viewportHeight,
    );
  }
  throw new Error("The page keeps changing or is too long to capture safely.");
}

async function captureFullPage(tab) {
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    files: ["page-text.js", "content.js"],
  });
  const port = chrome.tabs.connect(tab.id, {
    name: "fullPageCapture",
    frameId: 0,
  });
  try {
    const initial = await sendToPage(tab.id, { type: "fullPageCapture:start" });
    const session = { captures: 0 };
    const panels = [];
    let pixels = 0;
    try {
      for (let index = 0; index < Math.max(1, initial.regions?.length || 0); index++) {
        const metrics = index === 0 ? initial : await sendToPage(tab.id, {
          type: "fullPageCapture:select", index,
        });
        if (metrics.windowWidth !== initial.windowWidth || metrics.windowHeight !== initial.windowHeight ||
            JSON.stringify(metrics.regions) !== JSON.stringify(initial.regions)) {
          throw new Error("The application layout changed during capture. Please retry.");
        }
        const canvas = await capturePass(tab, metrics, session);
        panels.push({ canvas, crop: metrics.crop, background: initial.regions?.[index]?.background });
        pixels += canvas.width * canvas.height;
        if (pixels > MAX_CANVAS_PIXELS) throw new Error("The combined scrolling areas are too large to capture safely.");
      }
      document.getElementById("statusTitle").textContent = "Finishing capture…";
      const resultCanvas = initial.regions?.length
        ? composeApplicationScreenshot(session.shell, panels, initial)
        : panels[0].canvas;
      try {
        const result = resultCanvas.toDataURL("image/png");
        if (!result.startsWith("data:image/png")) throw new Error("Chrome could not encode a PNG of this size.");
        const pageText = await sendToPage(tab.id, { type: "fullPageCapture:text" });
        return { screenshot: result, ...pageText };
      } finally {
        if (resultCanvas !== panels[0].canvas) resultCanvas.width = resultCanvas.height = 0;
      }
    } finally {
      // Drop the viewport image before restoring the page.
      session.shell = null;
    }
  } finally {
    try {
      await sendToPage(tab.id, { type: "fullPageCapture:restore" });
    } finally {
      port.disconnect();
    }
  }
}

let progressValue = 0;

function showTextStats(stats) {
  if (!stats) return;
  const format = (value) => value >= 1000 ? `${(value / 1000).toFixed(1)}K` : String(value);
  document.getElementById("textTokens").textContent = `~${format(stats.estimatedTokens)} tokens`;
  document.getElementById("textCharacters").textContent = `${format(stats.characters)} chars${stats.truncated ? " · Text limit reached" : ""}`;
}

function showProgress(region, total, fraction, section) {
  progressValue = Math.max(progressValue, Math.min(95, Math.round((region + fraction) / total * 95)));
  document.getElementById("statusTitle").textContent = total > 1
    ? `Capturing area ${region + 1} of ${total}` : "Capturing…";
  document.getElementById("statusDetail").textContent = `Section ${section} · Keep popup open.`;
  document.getElementById("progressFill").style.width = `${progressValue}%`;
  document.getElementById("captureProgress").setAttribute("aria-valuenow", progressValue);
}

function setStatus(state, title, detail) {
  document.body.dataset.state = state;
  document.getElementById("statusTitle").textContent = title;
  document.getElementById("statusDetail").textContent = detail;
  document.getElementById("statusGlyph").setAttribute("d",
    state === "error" ? "M10 4v7m0 4v.1" : "M5 10l3 3 7-7");
}

function friendlyError(error) {
  if (/Cannot access|cannot be scripted|extensions gallery/i.test(error.message)) {
    return "Open a regular webpage, then try again. Chrome protects this page from scrolling access.";
  }
  return error.message || "Something interrupted the capture. Please try again.";
}

preview.addEventListener("load", () => {
  document.getElementById("imageMeta").textContent =
    `${preview.naturalWidth.toLocaleString()} × ${preview.naturalHeight.toLocaleString()} px · PNG`;
});

document.getElementById("zoomPreview").addEventListener("click", (event) => {
  const actual = document.getElementById("previewViewport").classList.toggle("actual-size");
  event.currentTarget.setAttribute("aria-pressed", String(actual));
  event.currentTarget.setAttribute("aria-label", actual ? "Fit screenshot to preview" : "Show screenshot at actual size");
  event.currentTarget.textContent = actual ? "Fit" : "100%";
});

button.addEventListener("click", async () => {
  destinationUI.suspend();
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  document.getElementById("buttonLabel").textContent = "Capturing…";
  progressValue = 0;
  document.getElementById("progressFill").style.width = "0%";
  document.getElementById("captureProgress").hidden = false;
  document.getElementById("captureProgress").setAttribute("aria-valuenow", "0");
  document.getElementById("pageText").hidden = false;
  document.getElementById("pageText").open = false;
  document.getElementById("textPreview").textContent = "Collecting rendered page text…";
  showTextStats({ characters: 0, estimatedTokens: 0 });
  setStatus("capturing", "Capturing…", "Keep popup open.");
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error("No active tab was found.");
    const result = await captureFullPage(tab);
    capturedPage = result;
    preview.src = result.screenshot;
    showTextStats(result);
    document.getElementById("textPreview").textContent = result.text || "No rendered page text was found.";
    document.getElementById("emptyState").hidden = true;
    for (const id of ["previewToolbar", "previewViewport", "imageMeta"]) {
      document.getElementById(id).hidden = false;
    }
    const viewport = document.getElementById("previewViewport");
    viewport.classList.remove("actual-size");
    viewport.scrollTop = viewport.scrollLeft = 0;
    const zoom = document.getElementById("zoomPreview");
    zoom.textContent = "100%";
    zoom.setAttribute("aria-pressed", "false");
    zoom.setAttribute("aria-label", "Show screenshot at actual size");
    setStatus("success", "", "");
    await destinationUI.show(result);
  } catch (error) {
    console.error(error);
    setStatus("error", "Couldn’t capture this page", friendlyError(error));
    document.getElementById("pageText").hidden = !capturedPage;
    if (capturedPage) {
      showTextStats(capturedPage);
      document.getElementById("textPreview").textContent = capturedPage.text || "No rendered page text was found.";
      destinationUI.resume();
    }
  } finally {
    button.disabled = false;
    button.removeAttribute("aria-busy");
    document.getElementById("captureProgress").hidden = true;
    document.getElementById("buttonLabel").textContent =
      document.body.dataset.state === "error" ? "Try again" : "Capture again";
  }
});
