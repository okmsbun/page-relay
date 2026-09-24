(() => {
  if (globalThis.__fullPageCaptureInstalled) return;
  globalThis.__fullPageCaptureInstalled = true;

  const POLL_MS = 100;
  const QUIET_MS = 400;
  const SETTLE_TIMEOUT_MS = 5000;
  let captureState = null;

  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function documentHeight() {
    const root = document.documentElement;
    const body = document.body;
    return Math.max(
      root.scrollHeight,
      root.offsetHeight,
      root.clientHeight,
      body?.scrollHeight ?? 0,
      body?.offsetHeight ?? 0,
    );
  }

  function clientRect(element) {
    const rect = element.getBoundingClientRect();
    const scaleX = rect.width / element.offsetWidth;
    const scaleY = rect.height / element.offsetHeight;
    return {
      x: rect.left + element.clientLeft * scaleX,
      y: rect.top + element.clientTop * scaleY,
      width: element.clientWidth * scaleX,
      height: element.clientHeight * scaleY,
    };
  }

  function visibleRect(element) {
    const box = clientRect(element);
    let left = Math.max(0, box.x);
    let top = Math.max(0, box.y);
    let right = Math.min(innerWidth, box.x + box.width);
    let bottom = Math.min(innerHeight, box.y + box.height);
    for (
      let parent = element.parentElement;
      parent;
      parent = parent.parentElement
    ) {
      const style = getComputedStyle(parent);
      const clip = clientRect(parent);
      if (/auto|scroll|hidden|clip/.test(style.overflowX)) {
        left = Math.max(left, clip.x);
        right = Math.min(right, clip.x + clip.width);
      }
      if (/auto|scroll|hidden|clip/.test(style.overflowY)) {
        top = Math.max(top, clip.y);
        bottom = Math.min(bottom, clip.y + clip.height);
      }
    }
    return {
      x: left,
      y: top,
      width: Math.max(0, right - left),
      height: Math.max(0, bottom - top),
    };
  }

  function findScrollTargets() {
    // Prefer ordinary long documents over embedded editors, code blocks, etc.
    if (documentHeight() - innerHeight > innerHeight / 2) return [];
    const candidates = [];
    for (const element of document.querySelectorAll("*")) {
      if (
        element === document.body ||
        element === document.documentElement ||
        element.scrollHeight <= element.clientHeight + 1
      )
        continue;
      const style = getComputedStyle(element);
      if (
        !/^(auto|scroll|overlay)$/.test(style.overflowY) ||
        style.visibility === "hidden" ||
        style.display === "none"
      )
        continue;
      const rect = visibleRect(element);
      const area = rect.width * rect.height;
      if (
        rect.width >= innerWidth * 0.08 &&
        rect.height >= innerHeight * 0.3 &&
        area > innerWidth * innerHeight * 0.04
      ) {
        candidates.push({ element, rect, area });
      }
    }
    // Capture large, independent panels (including navigation). Nested/overlapping
    // scrollers stay in their parent's visible layout rather than being overlaid twice.
    const selected = [];
    for (const candidate of candidates.sort((a, b) => b.area - a.area)) {
      if (
        selected.some(
          ({ element, rect }) =>
            element.contains(candidate.element) ||
            candidate.element.contains(element) ||
            (Math.min(
              rect.x + rect.width,
              candidate.rect.x + candidate.rect.width,
            ) > Math.max(rect.x, candidate.rect.x) &&
              Math.min(
                rect.y + rect.height,
                candidate.rect.y + candidate.rect.height,
              ) > Math.max(rect.y, candidate.rect.y)),
        )
      )
        continue;
      selected.push(candidate);
    }
    if (selected.length > 8)
      throw new Error(
        "This layout has too many independent scrolling areas to capture safely.",
      );
    return selected.map(({ element }) => element);
  }

  function backgroundColor(element) {
    for (; element; element = element.parentElement) {
      const color = getComputedStyle(element).backgroundColor;
      if (color && color !== "transparent" && color !== "rgba(0, 0, 0, 0)")
        return color;
    }
    return "#ffffff";
  }

  function getMetrics() {
    const target = captureState?.target;
    const crop = target
      ? visibleRect(target)
      : { x: 0, y: 0, width: innerWidth, height: innerHeight };
    if (target) {
      const box = clientRect(target);
      // Cropped-off vertical rows cannot be recovered by scrolling this element.
      if (
        !target.isConnected ||
        crop.width <= 0 ||
        crop.height <= 0 ||
        Math.abs(crop.y - box.y) > 1 ||
        Math.abs(crop.height - box.height) > 1
      ) {
        throw new Error(
          "Bring the main scrolling area fully into view, then try again.",
        );
      }
    }
    return {
      documentHeight: target ? target.scrollHeight : documentHeight(),
      viewportHeight: target ? target.clientHeight : innerHeight,
      viewportWidth: target ? target.clientWidth : innerWidth,
      windowHeight: innerHeight,
      windowWidth: innerWidth,
      crop,
      scrollX: target ? target.scrollLeft : window.scrollX,
      scrollY: target ? target.scrollTop : window.scrollY,
      regionIndex: captureState?.regionIndex ?? 0,
      regions:
        captureState?.targets.map(({ element }) => ({
          crop: visibleRect(element),
          background: backgroundColor(element),
        })) ?? [],
      background: backgroundColor(document.body),
      textStats: captureState?.text.stats(),
    };
  }

  // Save each property's original value only once, including its !important flag.
  function setTemporaryStyle(element, property, value) {
    let saved = captureState.savedStyles.get(element);
    if (!saved) {
      saved = { properties: new Map(), order: [...element.style] };
      captureState.savedStyles.set(element, saved);
    }
    const { properties } = saved;
    if (!properties.has(property)) {
      properties.set(property, {
        value: element.style.getPropertyValue(property),
        priority: element.style.getPropertyPriority(property),
      });
    }
    if (
      element.style.getPropertyValue(property) !== value ||
      element.style.getPropertyPriority(property) !== "important"
    ) {
      element.style.setProperty(property, value, "important");
    }
  }

  function normalizeOverlays() {
    const target = captureState.target;
    // Repeat after scrolling: sites may insert a header or make it fixed later.
    // A fixed app shell may contain the scroller: never hide it or its ancestors.
    const scopes = target
      ? captureState.targets.map(({ element }) => element)
      : [document];
    for (const element of scopes.flatMap((scope) => [
      ...scope.querySelectorAll("*"),
    ])) {
      const position = getComputedStyle(element).position;
      if (position === "fixed") {
        // Opacity also hides descendants that explicitly set visibility: visible.
        setTemporaryStyle(element, "opacity", "0");
      } else if (position === "sticky") {
        // Keep its space and contents in normal flow, with no sticky offsets.
        setTemporaryStyle(element, "position", "relative");
        for (const property of [
          "top",
          "right",
          "bottom",
          "left",
          "inset-block-start",
          "inset-block-end",
          "inset-inline-start",
          "inset-inline-end",
        ]) {
          setTemporaryStyle(element, property, "auto");
        }
      }
    }
  }

  function requireState(state) {
    if (!state || captureState !== state) {
      throw new Error("Capture was cancelled.");
    }
  }

  function restoreCaptureState() {
    const state = captureState;
    if (!state) return;
    captureState = null;
    state.observer.disconnect();

    // Restore the position while scroll snap and smooth scrolling are disabled.
    window.scrollTo({
      left: state.scrollX,
      top: state.scrollY,
      behavior: "instant",
    });
    for (const { element, x, y } of state.targets) {
      element.scrollTo({
        left: x,
        top: y,
        behavior: "instant",
      });
    }
    for (const [element, { properties, order }] of state.savedStyles) {
      for (const property of properties.keys())
        element.style.removeProperty(property);
      // Logical and physical offsets can conflict: retain their original order.
      for (const property of order) {
        const original = properties.get(property);
        if (original?.value) {
          element.style.setProperty(
            property,
            original.value,
            original.priority,
          );
        }
      }
    }
  }

  function visibleImagesPending() {
    const target = captureState.target;
    const crop = getMetrics().crop;
    const images = target ? target.querySelectorAll("img") : document.images;
    return [...images].some((image) => {
      if (image.complete) return false;
      const rect = image.getBoundingClientRect();
      return (
        rect.bottom > crop.y &&
        rect.top < crop.y + crop.height &&
        rect.right > crop.x &&
        rect.left < crop.x + crop.width
      );
    });
  }

  async function settle(minimumWait = QUIET_MS) {
    const state = captureState;
    requireState(state);
    const started = performance.now();
    let stableSince = started;
    let previous = "";

    while (performance.now() - started < SETTLE_TIMEOUT_MS) {
      await delay(POLL_MS);
      requireState(state);
      normalizeOverlays();
      const metrics = getMetrics();
      const signature = JSON.stringify(metrics);
      const now = performance.now();
      if (
        signature !== previous ||
        visibleImagesPending() ||
        document.fonts?.status === "loading"
      ) {
        stableSince = now;
        previous = signature;
      }
      if (
        now - started >= minimumWait &&
        now - stableSince >= QUIET_MS &&
        now - state.lastMutation >= QUIET_MS
      ) {
        state.text.sample();
        return metrics;
      }
    }

    // Animated pages need a bound; unresolved visible images must not be saved blank.
    if (visibleImagesPending() || document.fonts?.status === "loading") {
      throw new Error(
        "Page resources are still loading. Wait for them and try again.",
      );
    }
    state.text.sample();
    return getMetrics();
  }

  async function startCapture() {
    restoreCaptureState();
    const targets = findScrollTargets().map((element) => ({
      element,
      x: element.scrollLeft,
      y: element.scrollTop,
    }));
    const target = targets[0]?.element;
    const state = {
      targets,
      regionIndex: 0,
      target,
      targetX: target?.scrollLeft,
      scrollX: window.scrollX,
      scrollY: window.scrollY,
      savedStyles: new Map(),
      text: new PageTextCollector(targets.map(({ element }) => element)),
      lastMutation: performance.now(),
      observer: new MutationObserver(() => {
        state.lastMutation = performance.now();
      }),
    };
    captureState = state;
    // Preserve initially visible persistent UI before capture-only style changes.
    state.text.sample();
    state.observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });

    for (const element of [
      document.documentElement,
      document.body,
      ...targets.map(({ element }) => element),
    ].filter(Boolean)) {
      setTemporaryStyle(element, "scroll-behavior", "auto");
      setTemporaryStyle(element, "scroll-snap-type", "none");
      setTemporaryStyle(element, "overflow-anchor", "none");
    }
    // Save the app frame with every independent panel at its first row.
    for (const { element, x } of targets) {
      element.scrollTo({ left: x, top: 0, behavior: "instant" });
    }
    return scrollToPosition(0);
  }

  async function scrollToPosition(scrollY, minimumWait) {
    requireState(captureState);
    normalizeOverlays();
    const target = captureState.target;
    (target || window).scrollTo({
      left: target ? captureState.targetX : captureState.scrollX,
      top: scrollY,
      behavior: "instant",
    });
    return settle(minimumWait);
  }

  // If the popup closes mid-capture, still restore the page.
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name === "fullPageCapture") {
      port.onDisconnect.addListener(restoreCaptureState);
    }
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message?.type?.startsWith("fullPageCapture:")) return undefined;

    const handleMessage = async () => {
      switch (message.type) {
        case "fullPageCapture:start":
          return startCapture();
        case "fullPageCapture:scroll":
          return scrollToPosition(message.scrollY, message.minimumWait);
        case "fullPageCapture:select": {
          requireState(captureState);
          const region = captureState.targets[message.index];
          if (!region)
            throw new Error("The requested scrolling area is unavailable.");
          captureState.regionIndex = message.index;
          captureState.target = region.element;
          captureState.targetX = region.x;
          return scrollToPosition(0);
        }
        case "fullPageCapture:measure":
          requireState(captureState);
          captureState.text.sample();
          return getMetrics();
        case "fullPageCapture:text":
          requireState(captureState);
          captureState.text.sample();
          return captureState.text.result();
        case "fullPageCapture:settle":
          return settle(message.minimumWait);
        case "fullPageCapture:restore":
          restoreCaptureState();
          return { restored: true };
        default:
          throw new Error(`Unknown capture message: ${message.type}`);
      }
    };

    handleMessage()
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  });
})();
