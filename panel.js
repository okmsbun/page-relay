const preview = document.getElementById("preview");

// Measured: Chrome allows at most 2 captureVisibleTab calls per second, so this interval
// is the hard limit on segment speed once the page settles quickly. 550ms stays above the
// 500ms quota floor with margin (a sliding 1s window never sees a third call) and was the
// binding constraint after the settle wait was tightened.
const CAPTURE_INTERVAL_MS = 550;
const BOTTOM_WAIT_MS = 1500;
const MAX_CAPTURE_SEGMENTS = 200;
const MAX_LAYOUT_RETRIES = 2;
const LAYOUT_RETRY_SETTLE_MS = 600;
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

const GEOMETRY_EPSILON = 0.5;

function closeEnough(a, b) {
  return (
    Number.isFinite(a) &&
    Number.isFinite(b) &&
    Math.abs(a - b) <= GEOMETRY_EPSILON
  );
}

function sameCrop(a, b) {
  if (!a || !b) return a === b;
  return ["x", "y", "width", "height"].every((key) =>
    closeEnough(a[key], b[key]),
  );
}

function sameRegions(a = [], b = []) {
  return (
    a.length === b.length &&
    a.every((region, index) => sameCrop(region.crop, b[index]?.crop))
  );
}

function sameGeometry(a, b) {
  return (
    a.viewportHeight === b.viewportHeight &&
    a.viewportWidth === b.viewportWidth &&
    a.windowHeight === b.windowHeight &&
    a.windowWidth === b.windowWidth &&
    a.devicePixelRatio === b.devicePixelRatio &&
    sameCrop(a.crop, b.crop) &&
    sameRegions(a.regions, b.regions)
  );
}

function sameViewport(a, b) {
  return (
    sameGeometry(a, b) &&
    a.documentHeight === b.documentHeight &&
    closeEnough(a.scrollX, b.scrollX) &&
    closeEnough(a.scrollY, b.scrollY)
  );
}

function describeGeometryDiff(initial, current) {
  const diffs = [];
  for (const key of [
    "windowWidth",
    "windowHeight",
    "viewportWidth",
    "viewportHeight",
    "devicePixelRatio",
  ]) {
    if (initial[key] !== current[key]) {
      diffs.push(`${key}: ${initial[key]} -> ${current[key]}`);
    }
  }
  for (const key of ["x", "y", "width", "height"]) {
    if (!closeEnough(initial.crop?.[key], current.crop?.[key])) {
      diffs.push(
        `crop.${key}: ${initial.crop?.[key]} -> ${current.crop?.[key]}`,
      );
    }
  }
  const aRegions = initial.regions || [];
  const bRegions = current.regions || [];
  if (aRegions.length !== bRegions.length) {
    diffs.push(`regions.length: ${aRegions.length} -> ${bRegions.length}`);
  } else {
    for (let i = 0; i < aRegions.length; i++) {
      for (const key of ["x", "y", "width", "height"]) {
        if (!closeEnough(aRegions[i].crop?.[key], bRegions[i].crop?.[key])) {
          diffs.push(
            `regions[${i}].crop.${key}: ${aRegions[i].crop?.[key]} -> ${bRegions[i].crop?.[key]}`,
          );
        }
      }
    }
  }
  return diffs;
}

function layoutChangedError(
  message = "The page layout changed during capture. Wait for it to settle and retry.",
  diagnostic = null,
) {
  const error = new Error(message);
  error.layoutChanged = true;
  if (diagnostic) error.diagnostic = diagnostic;
  return error;
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
  let capturedCropHeight;
  let coveredPixels = 0;
  let requestedY = 0;
  let requestedEnd = false;
  let previousHeight = initial.documentHeight;
  let unstableCaptures = 0;

  for (let index = 0; index < MAX_CAPTURE_SEGMENTS; index++) {
    if (++session.captures > MAX_CAPTURE_SEGMENTS) {
      throw new Error("The page is too long to capture safely.");
    }
    showProgress(
      initial.regionIndex || 0,
      initial.regions?.length || 1,
      requestedY / previousHeight,
      index + 1,
    );
    // start already moved to the top; the last move probes the actual scroll limit.
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
    if (!sameGeometry(initial, before)) {
      const diffs = describeGeometryDiff(initial, before);
      throw layoutChangedError(
        "The page layout changed during capture. Wait for it to settle and retry.",
        {
          reason: "geometry-changed",
          segment: index + 1,
          region: initial.regionIndex || 0,
          scrollY: before.scrollY,
          diffs,
        },
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
    const [activeAfterCapture] = await chrome.tabs.query({
      active: true,
      windowId: tab.windowId,
    });
    if (activeAfterCapture?.id !== tab.id) {
      // A Side Panel stays open on tab switches. Never stitch another tab's pixels.
      throw new Error(
        "The active tab changed during capture. Keep the source tab active until capture finishes.",
      );
    }
    const after = await sendToPage(tab.id, { type: "fullPageCapture:measure" });
    showTextStats(after.textStats);
    if (!sameViewport(before, after)) {
      // Retry this position only; never start another full-page traversal.
      if (++unstableCaptures >= 3) {
        const diffs = describeGeometryDiff(before, after);
        if (before.documentHeight !== after.documentHeight) {
          diffs.push(
            `documentHeight: ${before.documentHeight} -> ${after.documentHeight}`,
          );
        }
        if (!closeEnough(before.scrollY, after.scrollY)) {
          diffs.push(`scrollY: ${before.scrollY} -> ${after.scrollY}`);
        }
        const error = new Error(
          "The page keeps changing during capture. Please wait and retry.",
        );
        error.diagnostic = {
          reason: "unstable-segment",
          segment: index + 1,
          region: initial.regionIndex || 0,
          scrollY: before.scrollY,
          diffs,
        };
        throw error;
      }
      requestedY = before.scrollY;
      requestedEnd = false;
      continue;
    }
    unstableCaptures = 0;
    const image = await loadImage(dataUrl);
    if (!session.shell && initial.regions?.length) session.shell = image;
    // captureVisibleTab returns the whole browser viewport, even for an element.
    // innerHeight/clientHeight are rounded CSS pixels. Dividing a rounded bitmap
    // height by them introduces scale drift at fractional DPR/zoom.
    const pixelX = before.devicePixelRatio;
    const pixelY = before.devicePixelRatio;
    const cropX = Math.round(before.crop.x * pixelX);
    const cropY = Math.round(before.crop.y * pixelY);
    const cropRight = before.crop.x + before.crop.width;
    const cropBottom = before.crop.y + before.crop.height;
    const cropWidth = (cropRight === before.windowWidth ? image.width :
      Math.min(image.width, Math.round(cropRight * pixelX))) - cropX;
    const cropHeight = (cropBottom === before.windowHeight ? image.height :
      Math.min(image.height, Math.round(cropBottom * pixelY))) - cropY;
    if (cropWidth <= 0 || cropHeight <= 0)
      throw new Error("The scrolling area is not visible.");

    if (!context) {
      scaleY = pixelY * before.crop.height / before.viewportHeight;
      capturedCropHeight = cropHeight;
      const height = Math.round(before.documentHeight * scaleY);
      checkCanvasSize(cropWidth, height);
      canvas.width = cropWidth;
      canvas.height = height;
      context = canvas.getContext("2d");
      if (!context)
        throw new Error("Could not allocate the screenshot canvas.");
    } else if (
      cropWidth !== canvas.width ||
      cropHeight !== capturedCropHeight
    ) {
      throw layoutChangedError(
        "The viewport size changed during capture. Please retry.",
        {
          reason: "viewport-bitmap-changed",
          segment: index + 1,
          region: initial.regionIndex || 0,
          diffs: [
            `cropBitmap: ${canvas.width}x${capturedCropHeight} -> ${cropWidth}x${cropHeight}`,
          ],
        },
      );
    }

    const segmentTop = Math.round(before.scrollY * scaleY);
    // Only an explicit request past the end proves that Chrome clamped the
    // scroller. The one-CSS-pixel bound accounts for scrollHeight/clientHeight
    // rounding; an early stuck scroller is never treated as a completed page.
    const atBottom =
      requestedY > before.scrollY + 1 &&
      Math.abs(
        before.scrollY + before.viewportHeight - before.documentHeight,
      ) <= 1;
    const atEnd = requestedEnd && atBottom;
    const height = atEnd ? segmentTop + cropHeight :
      Math.round(before.documentHeight * scaleY);
    if (height < coveredPixels) {
      throw layoutChangedError(
        "The page layout changed during capture. Wait for it to settle and retry.",
        {
          reason: "height-collapsed",
          segment: index + 1,
          region: initial.regionIndex || 0,
          scrollY: before.scrollY,
          diffs: [
            `canvasHeight: ${height} < coveredPixels: ${coveredPixels} (documentHeight ${previousHeight} -> ${before.documentHeight})`,
          ],
        },
      );
    }
    if (height !== canvas.height) {
      checkCanvasSize(canvas.width, height);
      // Preserve all covered rows on lazy growth, dynamic shrink above covered
      // rows, or the final raster-boundary correction. Never stretch or invent rows.
      const resized = document.createElement("canvas");
      resized.width = canvas.width;
      resized.height = height;
      const resizedContext = resized.getContext("2d");
      if (!resizedContext)
        throw new Error("Could not resize the screenshot canvas.");
      resizedContext.drawImage(canvas, 0, 0);
      canvas.width = canvas.height = 0;
      canvas = resized;
      context = resizedContext;
    }
    previousHeight = before.documentHeight;

    // Shared integer boundaries keep fractional DPR/zoom and the last crop aligned.
    const segmentBottom = Math.min(canvas.height, segmentTop + cropHeight);
    const doneAtShrunkBottom = atBottom && coveredPixels === canvas.height;
    if (
      segmentTop > coveredPixels ||
      (segmentBottom <= coveredPixels && !atEnd && !doneAtShrunkBottom)
    ) {
      const error = new Error(
        "The page could not be scrolled any farther without missing screenshot sections.",
      );
      error.diagnostic = {
        reason: "scroll-gap-or-stuck",
        segment: index + 1,
        region: initial.regionIndex || 0,
        scrollY: before.scrollY,
        requestedY,
        segmentTop,
        segmentBottom,
        coveredPixels,
        documentHeight: before.documentHeight,
      };
      throw error;
    }
    const sourceY = coveredPixels - segmentTop;
    const rows = segmentBottom - coveredPixels;
    if (rows > 0) context.drawImage(
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
    coveredPixels = Math.max(coveredPixels, segmentBottom);

    if ((atEnd || doneAtShrunkBottom) && coveredPixels === canvas.height) {
      return canvas;
    }
    // Leave overlap for scroll-position quantization. Once the final viewport
    // overlaps covered rows, ask past the end instead of repeatedly requesting
    // an integer scrollHeight - clientHeight that Chrome cannot reach exactly.
    const nextY = Math.max(0, coveredPixels / scaleY - Math.max(2, 2 / scaleY));
    requestedEnd = nextY >= before.documentHeight - before.viewportHeight;
    requestedY = requestedEnd ? before.documentHeight : nextY;
  }
  throw new Error("The page keeps changing or is too long to capture safely.");
}

async function captureFullPage(tab) {
  if (isProtectedPageUrl(tab.url)) throw protectedPageError();
  if (isUnsupportedPageUrl(tab.url)) throw unsupportedPageError();
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    files: ["page-text.js", "content.js"],
  });
  const port = chrome.tabs.connect(tab.id, {
    name: "fullPageCapture",
    frameId: 0,
  });
  try {
    for (let attempt = 0; attempt <= MAX_LAYOUT_RETRIES; attempt++) {
      const session = { captures: 0 };
      const panels = [];
      try {
        const initial = await sendToPage(tab.id, {
          type: "fullPageCapture:start",
        });
        let pixels = 0;
        for (
          let index = 0;
          index < Math.max(1, initial.regions?.length || 0);
          index++
        ) {
          const metrics =
            index === 0
              ? initial
              : await sendToPage(tab.id, {
                  type: "fullPageCapture:select",
                  index,
                });
          if (
            metrics.windowWidth !== initial.windowWidth ||
            metrics.windowHeight !== initial.windowHeight ||
            !sameRegions(metrics.regions, initial.regions)
          ) {
            throw layoutChangedError(
              "The application layout changed during capture. Please retry.",
              {
                reason: "application-regions-changed",
                region: index,
                diffs: describeGeometryDiff(initial, metrics),
              },
            );
          }
          const canvas = await capturePass(tab, metrics, session);
          panels.push({
            canvas,
            crop: metrics.crop,
            background: initial.regions?.[index]?.background,
          });
          pixels += canvas.width * canvas.height;
          if (pixels > MAX_CANVAS_PIXELS)
            throw new Error(
              "The combined scrolling areas are too large to capture safely.",
            );
        }
        document.getElementById("statusTitle").textContent = "Finishing capture…";
        const resultCanvas = initial.regions?.length
          ? composeApplicationScreenshot(session.shell, panels, initial)
          : panels[0].canvas;
        try {
          const result = resultCanvas.toDataURL("image/png");
          if (!result.startsWith("data:image/png"))
            throw new Error("Chrome could not encode a PNG of this size.");
          const pageText = await sendToPage(tab.id, {
            type: "fullPageCapture:text",
          });
          return { screenshot: result, ...pageText };
        } finally {
          if (resultCanvas !== panels[0].canvas)
            resultCanvas.width = resultCanvas.height = 0;
        }
      } catch (error) {
        if (!error?.layoutChanged || attempt >= MAX_LAYOUT_RETRIES) {
          if (error?.diagnostic) {
            error.diagnostic = { ...error.diagnostic, attempt: attempt + 1 };
          }
          throw error;
        }
        console.warn?.(
          "[Page Relay] Recovering from layout shift during capture:",
          error.diagnostic || error.message,
        );
        for (const panel of panels) {
          panel.canvas.width = panel.canvas.height = 0;
        }
        session.shell = null;
        progressValue = 0;
        const fill = document.getElementById("progressFill");
        if (fill?.style) fill.style.width = "0%";
        const statusTitle = document.getElementById("statusTitle");
        const statusDetail = document.getElementById("statusDetail");
        if (statusTitle) statusTitle.textContent = "Waiting for page to settle…";
        if (statusDetail)
          statusDetail.textContent = `The page layout shifted. Retrying (${attempt + 1}/${MAX_LAYOUT_RETRIES})…`;
        await sendToPage(tab.id, {
          type: "fullPageCapture:settle",
          minimumWait: LAYOUT_RETRY_SETTLE_MS,
        }).catch(() => delay(LAYOUT_RETRY_SETTLE_MS));
      } finally {
        // Drop the viewport image before restoring the page.
        session.shell = null;
      }
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
  const format = (value) =>
    value >= 1000 ? `${(value / 1000).toFixed(1)}K` : String(value);
  document.getElementById("textCharacters").textContent =
    `${format(stats.characters)} chars${stats.truncated ? " · Text limit reached" : ""}`;
}

function showProgress(region, total, fraction, section) {
  progressValue = Math.max(
    progressValue,
    Math.min(95, Math.round(((region + fraction) / total) * 95)),
  );
  document.getElementById("statusTitle").textContent =
    total > 1 ? `Capturing area ${region + 1} of ${total}` : "Capturing…";
  document.getElementById("statusDetail").textContent =
    `Section ${section} · Keep the source tab active until capture finishes.`;
  document.getElementById("progressFill").style.width = `${progressValue}%`;
  document
    .getElementById("captureProgress")
    .setAttribute("aria-valuenow", progressValue);
}

function setStatus(state, title, detail, hint = "") {
  document.body.dataset.state = state;
  document.body.classList?.toggle("has-capture", Boolean(capturedPage));
  document.getElementById("statusTitle").textContent = title;
  document.getElementById("statusDetail").textContent = detail;
  const hintNode = document.getElementById("statusHint");
  if (hintNode) hintNode.textContent = hint;
  const glyph =
    state === "restricted"
      ? "M10 2.75l5.75 2.4v4.6c0 3.7-2.45 6.85-5.75 7.75-3.3-.9-5.75-4.05-5.75-7.75v-4.6L10 2.75z"
      : state === "error"
        ? "M10 4v7m0 4v.1"
        : "M5 10l3 3 7-7";
  document.getElementById("statusGlyph").setAttribute("d", glyph);
}

// Chrome restricts scripting/scrolling access on its internal pages, extension pages,
// and Chrome Web Store routes (including account-prefixed developer console URLs).
// Every normal webpage is capturable, so lookup or permission failures must never be
// reported as browser-restricted pages.
const PROTECTED_PAGE_URL =
  /^(?:chrome|chrome-extension|chrome-untrusted|chrome-search|devtools|edge|brave|opera|about|view-source):/i;
const WEB_STORE_URL =
  /^https:\/\/(?:chromewebstore\.google\.com(?:\/|$|\?|#)|chrome\.google\.com\/(?:u\/\d+\/)?webstore(?:\/|$|\?|#))/i;
const UNSUPPORTED_PAGE_URL = /^(?:data|blob|javascript|mailto|tel):/i;
const RESTRICTED_PAGE_TITLE = "Restricted page";
const RESTRICTED_PAGE_MESSAGE =
  "Chrome restricts full-page capture on this page for security reasons.";
const RESTRICTED_PAGE_HINT =
  "Open another webpage to continue using Page Relay.";
const UNSUPPORTED_PAGE_TITLE = "Unsupported page";
const UNSUPPORTED_PAGE_MESSAGE =
  "Full-page capture is unavailable on this type of page.";

function isProtectedPageUrl(url) {
  return (
    typeof url === "string" &&
    (PROTECTED_PAGE_URL.test(url) || WEB_STORE_URL.test(url))
  );
}

function isUnsupportedPageUrl(url) {
  return typeof url === "string" && UNSUPPORTED_PAGE_URL.test(url);
}

function protectedPageError() {
  const error = new Error(RESTRICTED_PAGE_MESSAGE);
  error.protectedPage = true;
  error.expected = true;
  return error;
}

function unsupportedPageError() {
  const error = new Error(UNSUPPORTED_PAGE_MESSAGE);
  error.unsupportedPage = true;
  error.expected = true;
  return error;
}

function isPermissionError(error) {
  const message = String(error?.message ?? error ?? "");
  return /cannot access|cannot be scripted|permission/i.test(message);
}

function isProtectedError(error) {
  const message = String(error?.message ?? error ?? "");
  return Boolean(
    error?.protectedPage ||
      /chrome:\/\/|chrome-extension:\/\/|chrome-untrusted:\/\/|devtools:\/\/|extensions gallery|webstore/i.test(
        message,
      ),
  );
}

function isUnsupportedError(error) {
  return Boolean(error?.unsupportedPage);
}

function isExpectedCaptureError(error) {
  if (
    error?.expected ||
    isProtectedError(error) ||
    isUnsupportedError(error) ||
    isPermissionError(error)
  )
    return true;
  const message = String(error?.message ?? error ?? "");
  return /active tab changed|keep the captured tab active|could not be identified|no longer open|cancelled/i.test(
    message,
  );
}

function friendlyError(error) {
  const message = String(error?.message ?? error ?? "");
  if (isProtectedError(error)) return RESTRICTED_PAGE_MESSAGE;
  if (isUnsupportedError(error)) return UNSUPPORTED_PAGE_MESSAGE;
  if (isPermissionError(error))
    return "Chrome blocked access to this page’s content, so nothing was captured.";
  const base = message || "Something interrupted the capture. Please try again.";
  const summary = error?.diagnostic?.diffs?.slice(0, 2).join(", ");
  return summary ? `${base} (${summary})` : base;
}

preview.addEventListener("load", () => {
  document.getElementById("imageMeta").textContent =
    `${preview.naturalWidth.toLocaleString()} × ${preview.naturalHeight.toLocaleString()} px · PNG`;
});

document.getElementById("zoomPreview").addEventListener("click", (event) => {
  const actual = document
    .getElementById("previewViewport")
    .classList.toggle("actual-size");
  event.currentTarget.setAttribute("aria-pressed", String(actual));
  event.currentTarget.setAttribute(
    "aria-label",
    actual ? "Fit screenshot to preview" : "Show screenshot at actual size",
  );
  event.currentTarget.textContent = actual ? "Fit" : "100%";
});

const recaptureButton = document.getElementById("recapturePage");

let captureStarted = false;
let capturing = false;
let captureSourceTab = null;
let canRetrySource = false;

function isDestinationBusy() {
  return typeof destinationUI !== "undefined" && destinationUI.isBusy?.() === true;
}

function updateRecaptureButton() {
  if (!recaptureButton) return;
  const visible = Boolean(capturedPage || canRetrySource);
  recaptureButton.hidden = !visible;
  recaptureButton.disabled =
    !visible || capturing || !captureSourceTab || isDestinationBusy();
  if (capturing) recaptureButton.dataset.capturing = "true";
  else delete recaptureButton.dataset.capturing;
}

if (typeof destinationUI !== "undefined")
  destinationUI.onBusyChange?.(updateRecaptureButton);

async function waitForActiveTab(tabId, windowId, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [active] = await chrome.tabs
      .query({ active: true, windowId })
      .catch(() => []);
    if (active?.id === tabId) return true;
    await delay(50);
  }
  return false;
}

async function resolveRecaptureTab() {
  if (!captureSourceTab?.id) {
    const error = new Error("The tab to capture could not be identified.");
    error.expected = true;
    throw error;
  }
  if (!chrome?.tabs?.get) return captureSourceTab;
  let latest = await chrome.tabs.get(captureSourceTab.id).catch(() => null);
  if (!latest?.id) {
    const error = new Error("The captured source tab is no longer open.");
    error.expected = true;
    throw error;
  }
  if (latest.active === false) {
    try {
      if (chrome.windows?.update) {
        await chrome.windows
          .update(latest.windowId, { focused: true })
          .catch(() => {});
      }
      if (chrome.tabs?.update) {
        await chrome.tabs.update(latest.id, { active: true });
      } else {
        throw new Error("Tab activation is unavailable.");
      }
      if (chrome.tabs?.query) {
        const activated = await waitForActiveTab(latest.id, latest.windowId);
        if (!activated) throw new Error("Tab did not become active.");
      }
      // Allow the activated tab to paint before captureVisibleTab runs.
      await delay(120);
      latest = await chrome.tabs.get(latest.id).catch(() => null);
      if (!latest?.id) {
        const error = new Error("The captured source tab is no longer open.");
        error.expected = true;
        throw error;
      }
    } catch (cause) {
      if (cause?.expected) throw cause;
      const error = new Error(
        "Could not switch back to the source tab automatically. Activate it, then click Recapture.",
      );
      error.expected = true;
      throw error;
    }
  }
  return Object.freeze({
    id: latest.id,
    windowId: latest.windowId,
    url: latest.url ?? "",
  });
}

async function runPanelCapture(sourceTab) {
  if (capturing || isDestinationBusy()) return;
  capturing = true;
  updateRecaptureButton();
  const previewCard = document.querySelector(".preview-card");
  if (previewCard) previewCard.hidden = false;
  if (!capturedPage) {
    const emptyHeading = document.querySelector("#emptyState h2");
    if (emptyHeading) emptyHeading.textContent = "Preparing preview…";
  }
  document.getElementById("includePageText").checked = false;
  destinationUI.suspend();
  progressValue = 0;
  document.getElementById("progressFill").style.width = "0%";
  document.getElementById("captureProgress").hidden = false;
  document.getElementById("captureProgress").setAttribute("aria-valuenow", "0");
  document.getElementById("pageText").hidden = false;
  document.getElementById("pageText").open = false;
  document.getElementById("textPreview").textContent =
    "Collecting rendered page text…";
  showTextStats({ characters: 0 });
  setStatus(
    "capturing",
    "Capturing…",
    "Keep the source tab active until capture finishes.",
  );
  try {
    const tab = await sourceTab;
    if (!tab?.id) {
      const error = new Error("The tab to capture could not be identified.");
      error.expected = true;
      throw error;
    }
    captureSourceTab = Object.freeze({
      id: tab.id,
      windowId: tab.windowId,
      url: tab.url ?? "",
    });
    canRetrySource =
      !isProtectedPageUrl(tab.url) && !isUnsupportedPageUrl(tab.url);
    updateRecaptureButton();
    const result = await captureFullPage(tab);
    capturedPage = result;
    canRetrySource = true;
    preview.src = result.screenshot;
    showTextStats(result);
    document.getElementById("textPreview").textContent =
      result.text || "No rendered page text was found.";
    if (previewCard) previewCard.hidden = false;
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
    if (!isExpectedCaptureError(error)) {
      if (error?.diagnostic) {
        console.error("[Page Relay] Capture failed:", error.message, error.diagnostic);
      } else {
        console.error("[Page Relay] Capture failed:", error);
      }
    }
    const restricted = isProtectedError(error) || isUnsupportedError(error);
    if (restricted) {
      if (!capturedPage) {
        canRetrySource = false;
        if (previewCard) previewCard.hidden = true;
      }
      setStatus(
        "restricted",
        isProtectedError(error) ? RESTRICTED_PAGE_TITLE : UNSUPPORTED_PAGE_TITLE,
        friendlyError(error),
        RESTRICTED_PAGE_HINT,
      );
    } else {
      if (!capturedPage) {
        if (previewCard) previewCard.hidden = false;
        document.querySelector("#emptyState h2").textContent =
          "Preview unavailable";
        if (isPermissionError(error)) canRetrySource = false;
      }
      const canRecaptureNow = Boolean(
        captureSourceTab && (capturedPage || canRetrySource),
      );
      const recovery = canRecaptureNow
        ? "Click Recapture to try again, or reopen the Side Panel from the toolbar icon."
        : "Close the Side Panel, then reopen it using the extension toolbar icon to retry.";
      setStatus(
        "error",
        "Couldn’t capture this page",
        `${friendlyError(error)} ${recovery}`,
      );
    }
    document.getElementById("pageText").hidden = !capturedPage;
    if (capturedPage) {
      showTextStats(capturedPage);
      document.getElementById("textPreview").textContent =
        capturedPage.text || "No rendered page text was found.";
      destinationUI.resume();
    }
  } finally {
    capturing = false;
    document.getElementById("captureProgress").hidden = true;
    updateRecaptureButton();
  }
}

async function startPanelCapture(sourceTab) {
  if (captureStarted) return;
  captureStarted = true;
  return runPanelCapture(sourceTab);
}

recaptureButton?.addEventListener("click", () => {
  void runPanelCapture(resolveRecaptureTab());
});
