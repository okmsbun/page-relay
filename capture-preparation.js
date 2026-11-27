/* Stable identity and TXT bytes for one captured page. No composer text is generated. */
const CapturePreparation = (() => {
  const captures = new WeakMap();
  function payload(destination, capture, options = {}) {
    let files = captures.get(capture);
    if (!files) {
      const deliveryId = crypto.randomUUID();
      const line = (value) => String(value || "").replace(/[\r\n]+/g, " ");
      files = {
        deliveryId,
        png: `page-${deliveryId}.png`,
        txt: `page-${deliveryId}.txt`,
        screenshot: capture.screenshot,
        text: `Page title: ${line(capture.title) || "Untitled page"}\nURL: ${line(capture.url)}\n${capture.truncated ? "Note: Extracted page text was truncated because it reached a technical capture limit.\n" : ""}\n---\n\n${capture.text || ""}`,
      };
      captures.set(capture, files);
    }
    const includePng =
      options.includePng !== undefined
        ? options.includePng === true
        : capture.includePng !== false;
    const includeText =
      options.includeText !== undefined
        ? options.includeText === true
        : capture.includeText === true;
    const { screenshot, text, ...identity } = files;
    return {
      ...identity,
      ...(includePng ? { screenshot } : {}),
      ...(includeText ? { text } : {}),
      includePng,
      includeText,
      providerId: destination.providerId,
      expectedUrl: destination.url,
      deadline: Date.now() + 140000,
    };
  }
  return { payload };
})();

/* Self-contained: Chrome serializes this function into the selected tab's isolated
   world. Never edits the text editor, restores a draft, or activates a send control. */
async function prepareFilesInComposer(payload) {
  const provider = payload.providerId;
  const includePng = payload.includePng !== false;
  const includeText = payload.includeText === true;
  const requestedKinds = [
    ...(includePng ? ["png"] : []),
    ...(includeText ? ["txt"] : []),
  ];
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const visible = (node) =>
    node &&
    !node.closest('[hidden], [inert], [aria-hidden="true"]') &&
    node.getClientRects().length > 0 &&
    getComputedStyle(node).visibility !== "hidden";
  const url = () =>
    `${location.origin}${location.pathname.replace(/\/+$/, "") || "/"}${location.search}`;
  const selectors = {
    chatgpt:
      '#prompt-textarea, form[data-chatgpt-composer] [data-composer-markdown][contenteditable="true"]',
    claude: '[data-testid="chat-input"][contenteditable="true"]',
    gemini: 'rich-textarea [contenteditable="true"][role="textbox"]',
  };
  const editor = () => {
    const nodes = [...document.querySelectorAll(selectors[provider])].filter(
      visible,
    );
    return nodes.length === 1 ? nodes[0] : null;
  };
  const root = () =>
    editor()?.closest(
      provider === "chatgpt"
        ? "form"
        : provider === "claude"
          ? '[data-cds="ChatComposer"]'
          : '[data-node-type="input-area"]',
    );
  const textState = (node) =>
    node instanceof HTMLTextAreaElement ? node.value : node.innerHTML;
  const metadata = (node) => {
    const nodes = [
      node,
      ...node.querySelectorAll(
        "[title], [aria-label], [aria-describedby], img[alt]",
      ),
    ];
    return [
      node.innerText || "",
      ...nodes.filter(visible).flatMap((element) => [
        element.getAttribute("title") || "",
        element.getAttribute("aria-label") || "",
        element.getAttribute("alt") || "",
        ...(element.getAttribute("aria-describedby") || "")
          .split(/\s+/)
          .map((id) => document.getElementById(id)?.textContent || ""),
      ]),
    ].join(" ");
  };
  const filenameMatches = (node, name) => {
    if (!name) return false;
    const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const dot = name.lastIndexOf(".");
    const ext =
      provider === "gemini" && name === payload.png
        ? "\\.(?:png|jpe?g)"
        : escape(name.slice(dot));
    const suffix =
      provider === "gemini" && name === payload.png
        ? "(?:_[a-zA-Z0-9-]+)?"
        : "";
    return new RegExp(
      "(?:^|\\s)" + escape(name.slice(0, dot)) + suffix + ext + "(?=\\s|$)",
      "i",
    ).test(metadata(node));
  };
  const tiles = () => {
    const container = root();
    if (!container) return [];
    let nodes;
    if (provider === "gemini")
      nodes = [...container.querySelectorAll("uploader-file-preview")];
    else if (provider === "claude")
      nodes = [
        ...container.querySelectorAll(
          '[data-testid="file-thumbnail"], [data-cds-attachment]',
        ),
      ];
    else {
      nodes = [
        ...container.querySelectorAll(
          '[data-testid*="file-thumbnail"], [data-file-id], .group\\/composer-attachment',
        ),
      ];
      for (const button of container.querySelectorAll("button[aria-label]")) {
        if (
          !visible(button) ||
          !/^remove\s+|(?:file|attachment|image).*remove/i.test(
            button.getAttribute("aria-label"),
          )
        )
          continue;
        if (!nodes.some((node) => node.contains(button)))
          nodes.push(button.parentElement);
      }
      for (const node of container.querySelectorAll(
        '[data-testid*="attachment"]',
      )) {
        if (node.matches('button, input, [role="button"]')) continue;
        if (
          /(?:^|\s)[^\s/\\]+\.[a-z0-9]{1,12}(?=\s|$)/i.test(metadata(node)) ||
          node.querySelector("img[src]")
        )
          nodes.push(node);
      }
    }
    // Keep the innermost tile if a provider wraps tiles in an attachment container.
    const unique = [...new Set(nodes)].filter(
      (node) => node !== container && visible(node),
    );
    return unique.filter(
      (node) => !unique.some((child) => child !== node && node.contains(child)),
    );
  };
  const identity = (node) => {
    // Prefer stable file identity over DOM node identity (providers replace nodes).
    const fileId = node.getAttribute("data-file-id");
    if (fileId) return `id:${fileId}`;
    const values = [
      node,
      ...node.querySelectorAll(
        "[title], [aria-label], [aria-describedby], img[alt]",
      ),
    ]
      .filter(visible)
      .flatMap((element) => [
        element.getAttribute("title"),
        element.getAttribute("aria-label"),
        element.getAttribute("alt"),
        ...(element.getAttribute("aria-describedby") || "")
          .split(/\s+/)
          .map((id) => document.getElementById(id)?.textContent),
      ])
      .filter(Boolean)
      .filter((value) => !/^(remove|close)(\s|$)/i.test(value));
    const names = [...new Set(values)].sort();
    const images = [...node.querySelectorAll("img[src]")].map((image) =>
      image.getAttribute("src"),
    );
    const label = names.length ? names : (node.innerText || "").trim();
    return label.length || images.length
      ? JSON.stringify([label, images])
      : null;
  };
  const progress = () =>
    [
      ...(root()?.querySelectorAll(
        '[role="progressbar"], [aria-busy="true"], [data-cds="Spinner"]',
      ) || []),
    ].some(visible);
  const errorVisible = () =>
    [...document.querySelectorAll('[role="alert"], mat-error')].some(
      (node) => visible(node) && node.innerText.trim(),
    );
  const consent = () =>
    provider === "gemini" &&
    !!document.querySelector("upload-image-disclaimer-dialog");
  const ledger = (globalThis.__pageRelayPreparations ||= new Map());
  const key = `${payload.expectedUrl}:${payload.deliveryId}`;
  function readLedger() {
    const raw = ledger.get(key);
    if (!raw) return { png: null, txt: null };
    if (typeof raw === "string") return { png: raw, txt: raw };
    return { png: raw.png || null, txt: raw.txt || null };
  }
  function writeLedger(updates) {
    const next = { ...readLedger(), ...updates };
    ledger.set(key, next);
    return next;
  }

  let changed = false,
    locked = false,
    userEdited = false,
    initialText,
    initial = [];
  let pendingKinds = requestedKinds.slice();
  const delivered = [];
  const observeEdit = (event) => {
    if (
      event.isTrusted &&
      (event.target.closest?.(selectors[provider]) ||
        event.target.matches?.('input[type="file"]'))
    )
      userEdited = true;
  };
  const events = ["beforeinput", "input", "paste", "drop", "compositionstart"];
  function check(expectedMaxAdded = pendingKinds.length) {
    if (Date.now() >= payload.deadline)
      throw new Error(
        "Preparation timed out. Review this chat before adding again.",
      );
    if (url() !== payload.expectedUrl)
      throw new Error("The conversation changed. Review this chat.");
    const current = editor();
    if (!current || userEdited || textState(current) !== initialText)
      throw new Error(
        "The user draft changed while adding files. Nothing will be overwritten. Review this chat.",
      );
    const currentTiles = tiles();
    const available = [...currentTiles];
    for (const old of initial) {
      const index = available.findIndex((node) =>
        old.key ? identity(node) === old.key : node === old.node,
      );
      if (index < 0)
        throw new Error(
          "An existing attachment changed or disappeared. Review this chat; Page Relay will not retry.",
        );
      available.splice(index, 1);
    }
    if (available.length > expectedMaxAdded)
      throw new Error("Attachments changed while adding files. Review this chat.");
    if (consent())
      throw new Error(
        "Open Gemini and review its upload consent dialog, then retry.",
      );
    if (errorVisible())
      throw new Error(
        "The provider is showing an error. Review this chat and its upload status.",
      );
  }
  async function until(predicate, duration = 10000) {
    const deadline = Math.min(payload.deadline, Date.now() + duration);
    while (Date.now() < deadline) {
      check();
      if (predicate()) return true;
      await wait(250);
    }
    return false;
  }
  function accepts(input, extension, mime) {
    return (
      !input.accept ||
      input.accept
        .toLowerCase()
        .split(",")
        .map((value) => value.trim())
        .some((value) =>
          ["*", "*/*", extension, mime, mime.split("/")[0] + "/*"].includes(
            value,
          ),
        )
    );
  }
  function validateInput(nodes) {
    if (nodes.length !== 1 || nodes[0].disabled || !nodes[0].multiple)
      throw new Error(
        "The upload control is unavailable or changed. No further files were added.",
      );
    const input = nodes[0];
    // Never replace an unresolved native selection. Already rendered, ready files
    // belong to provider state and are not copied into the new upload batch.
    if (
      [...(input.files || [])].some(
        (file) => !tiles().some((tile) => filenameMatches(tile, file.name)),
      )
    )
      throw new Error(
        "A file selection has not finished loading. Wait for its attachments to appear, then retry.",
      );
    return input;
  }

  let geminiMenuToggle = null;
  function geminiMenuOverlayOpen() {
    return [
      ...document.querySelectorAll(
        ".cdk-overlay-pane uploader, .cdk-overlay-pane images-files-uploader",
      ),
    ].some(visible);
  }
  function geminiMenuIsOpen(toggle = geminiMenuToggle) {
    return Boolean(
      (toggle?.isConnected && toggle.getAttribute("aria-expanded") === "true") ||
        geminiMenuOverlayOpen(),
    );
  }
  function closeGeminiMenu() {
    const toggle = geminiMenuToggle;
    geminiMenuToggle = null;
    if (!toggle) return;
    // Never re-open a menu Gemini already auto-closed after file handoff.
    if (toggle.isConnected && toggle.getAttribute("aria-expanded") === "true") {
      toggle.click();
      return;
    }
    if (geminiMenuOverlayOpen()) {
      const backdrop = [...document.querySelectorAll(".cdk-overlay-backdrop")].find(
        visible,
      );
      if (backdrop) backdrop.click();
      else if (toggle.isConnected) toggle.click();
    }
  }
  function geminiCandidates(selector) {
    return [...document.querySelectorAll(selector)].filter(
      (node) => node.multiple && !node.hasAttribute("capture"),
    );
  }
  function findGeminiControls(needPng, needTxt) {
    const directImageInputs = geminiCandidates('uploader input[type="file"]').filter(
      (node) =>
        !node.closest("images-files-uploader") &&
        node.accept &&
        accepts(node, ".png", "image/png") &&
        !accepts(node, ".txt", "text/plain"),
    );
    const directTextInputs = geminiCandidates(
      'images-files-uploader > input[type="file"]',
    ).filter((node) => accepts(node, ".txt", "text/plain"));
    const uploaderTextInputs = geminiCandidates(
      'uploader > input[type="file"]',
    ).filter(
      (node) =>
        node.accept &&
        accepts(node, ".txt", "text/plain") &&
        !accepts(node, ".png", "image/png"),
    );
    const unifiedInputs = geminiCandidates(
      'images-files-uploader input[type="file"], uploader input[type="file"]',
    ).filter(
      (node) =>
        (!needPng || accepts(node, ".png", "image/png")) &&
        (!needTxt || accepts(node, ".txt", "text/plain")),
    );
    if (needPng && !needTxt) {
      if (directImageInputs.length === 1) {
        return { mode: "single", inputs: directImageInputs };
      }
      if (unifiedInputs.length === 1) {
        return { mode: "single", inputs: unifiedInputs };
      }
      return null;
    }
    if (!needPng && needTxt) {
      const textInputs =
        directTextInputs.length === 1
          ? directTextInputs
          : uploaderTextInputs.length === 1
            ? uploaderTextInputs
            : unifiedInputs.length === 1
              ? unifiedInputs
              : [];
      return textInputs.length === 1
        ? { mode: "single", inputs: textInputs }
        : null;
    }
    if (directImageInputs.length === 1) {
      const textInputs =
        directTextInputs.length === 1
          ? directTextInputs
          : uploaderTextInputs.length === 1
            ? uploaderTextInputs
            : unifiedInputs.length === 1
              ? unifiedInputs
              : [];
      if (textInputs.length === 1) {
        return { mode: "separate", imageInputs: directImageInputs, textInputs };
      }
      return null;
    }
    if (unifiedInputs.length === 1) {
      return { mode: "unified", inputs: unifiedInputs };
    }
    return null;
  }
  async function resolveGeminiControls(needPng, needTxt) {
    check();
    let controls = findGeminiControls(needPng, needTxt);
    if (!controls) {
      const toggle = root()?.querySelector(
        'simplified-input-menu button[aria-haspopup="menu"], uploader button[aria-haspopup="menu"]',
      );
      if (!visible(toggle))
        throw new Error(
          "Gemini’s upload menu is unavailable. Open the tab, then retry.",
        );
      if (toggle.getAttribute("aria-expanded") !== "true") {
        toggle.click();
        geminiMenuToggle = toggle;
      }
      if (
        !(await until(() => {
          controls = findGeminiControls(needPng, needTxt);
          return Boolean(controls);
        }, 10000))
      ) {
        const anyImage = geminiCandidates('uploader input[type="file"]').some(
          (node) => accepts(node, ".png", "image/png"),
        );
        if (needTxt && anyImage) {
          throw new Error("Gemini’s upload control does not accept TXT files.");
        }
        throw new Error("Gemini’s upload control did not appear.");
      }
    }
    if (controls.mode === "single" || controls.mode === "unified") {
      return { mode: controls.mode, input: validateInput(controls.inputs) };
    }
    const imageInput = validateInput(controls.imageInputs);
    const textInput = validateInput(controls.textInputs);
    return { mode: "separate", imageInput, textInput };
  }
  async function awaitGeminiHandoff(input, openedToggle) {
    // Allow Gemini's Angular change handler to consume the selected files and
    // auto-close its upload menu before another input change, menu cleanup, or
    // tab restore runs. Do not short-circuit on input.files.length === 0 because
    // Gemini clears input.value synchronously before Angular finishes handoff.
    // Never waits for upload completion, preview rendering, or the Send button.
    const menuClosed = () =>
      !input.isConnected ||
      (openedToggle?.isConnected &&
        openedToggle.getAttribute("aria-expanded") !== "true" &&
        !geminiMenuOverlayOpen());
    if (menuClosed()) return;
    const deadline = Math.min(payload.deadline, Date.now() + 250);
    while (Date.now() < deadline && !menuClosed()) {
      await wait(25);
    }
  }
  function upload(input, files, kinds) {
    check();
    const data = new DataTransfer();
    for (const file of files) data.items.add(file);
    changed = true;
    // Retained even if the tab/panel interrupts execution.
    const reviewMarks = {};
    for (const kind of kinds) reviewMarks[kind] = "review";
    writeLedger(reviewMarks);
    input.files = data.files;
    if (input.files.length !== files.length)
      throw new Error("The upload control did not accept the selected files.");
    input.dispatchEvent(new Event("change", { bubbles: true }));
    check();
  }

  try {
    if (!selectors[provider]) throw new Error("Unsupported provider.");
    if (url() !== payload.expectedUrl)
      throw new Error(
        "The conversation changed. Refresh and select it again.",
      );
    if (!requestedKinds.length) {
      return { prepared: true, duplicate: true, delivered: [] };
    }
    if (globalThis.__pageCapturePreparing)
      return {
        prepared: false,
        needsReview: false,
        busy: true,
        delivered: [],
        error:
          "Another capture is being prepared in this tab. Wait, then retry.",
      };
    const existingLedger = readLedger();
    if (requestedKinds.some((kind) => existingLedger[kind] === "review")) {
      return {
        prepared: false,
        needsReview: true,
        delivered: requestedKinds.filter(
          (kind) => existingLedger[kind] === "prepared",
        ),
        error:
          "This capture was already attempted. Review the existing files before adding again.",
      };
    }
    pendingKinds = requestedKinds.filter(
      (kind) => existingLedger[kind] !== "prepared",
    );
    if (!pendingKinds.length) {
      return { prepared: true, duplicate: true, delivered: requestedKinds };
    }
    if (!editor() || !root())
      throw new Error(
        "The message composer is unavailable. Open this chat and sign in.",
      );
    const stop =
      provider === "chatgpt"
        ? '[data-testid="stop-button"]'
        : provider === "claude"
          ? '[data-testid="stop-response"]'
          : "gem-icon-button.send-button.stop, .stop-button";
    if ([...document.querySelectorAll(stop)].some(visible))
      return {
        prepared: false,
        needsReview: false,
        busy: true,
        delivered: [],
        error:
          "Generating a response. Wait for it to finish, then click Add again.",
      };
    if (progress())
      return {
        prepared: false,
        needsReview: false,
        busy: true,
        delivered: [],
        error:
          "Existing attachments are still uploading. Wait, then click Add again.",
      };
    initialText = textState(editor());
    initial = tiles().map((node) => ({ node, key: identity(node) }));
    check();
    globalThis.__pageCapturePreparing = payload.deliveryId;
    locked = true;
    for (const event of events)
      document.addEventListener(event, observeEdit, true);

    // DOM evidence protects against duplicate uploads after an isolated-world
    // ledger reset while allowing follow-up delivery of a missing attachment.
    const currentTiles = tiles();
    const pendingMatches = pendingKinds.map((kind) => ({
      kind,
      nodes: currentTiles.filter((node) => filenameMatches(node, payload[kind])),
    }));
    const anyPendingPresent = pendingMatches.some((item) => item.nodes.length > 0);
    if (anyPendingPresent) {
      changed = true;
      const allPendingDistinct =
        pendingMatches.every((item) => item.nodes.length === 1) &&
        new Set(pendingMatches.map((item) => item.nodes[0])).size ===
          pendingKinds.length;
      if (!allPendingDistinct) {
        throw new Error(
          "This capture was already added or partially prepared. Review its files before adding again.",
        );
      }
      const marks = {};
      for (const kind of pendingKinds) marks[kind] = "prepared";
      writeLedger(marks);
      return { prepared: true, duplicate: true, delivered: requestedKinds };
    }

    const needPng = pendingKinds.includes("png");
    const needTxt = pendingKinds.includes("txt");
    let png = null;
    if (needPng) {
      if (!payload.screenshot?.startsWith("data:image/png;base64,"))
        throw new Error("The captured screenshot is not a PNG.");
      const bytes = Uint8Array.from(
        atob(payload.screenshot.split(",")[1]),
        (character) => character.charCodeAt(0),
      );
      png = new File([bytes], payload.png, { type: "image/png" });
    }
    const txt = needTxt
      ? new File([payload.text ?? ""], payload.txt, { type: "text/plain" })
      : null;

    if (provider === "gemini") {
      const controls = await resolveGeminiControls(needPng, needTxt);
      if (controls.mode === "separate") {
        // Hand off PNG first and let Gemini's Angular handler consume it before
        // handing off TXT; firing both inputs synchronously drops the PNG on live Gemini.
        upload(controls.imageInput, [png], ["png"]);
        await awaitGeminiHandoff(controls.imageInput, geminiMenuToggle);
        writeLedger({ png: "prepared" });
        delivered.push("png");

        let textInput = controls.textInput;
        if (!textInput?.isConnected || textInput.disabled) {
          const refreshed = await resolveGeminiControls(false, true);
          textInput = refreshed.input;
        }
        upload(textInput, [txt], ["txt"]);
        await awaitGeminiHandoff(textInput, geminiMenuToggle);
        writeLedger({ txt: "prepared" });
        delivered.push("txt");
      } else {
        const batch = [...(png ? [png] : []), ...(txt ? [txt] : [])];
        upload(controls.input, batch, pendingKinds);
        await awaitGeminiHandoff(controls.input, geminiMenuToggle);
        const marks = {};
        for (const kind of pendingKinds) marks[kind] = "prepared";
        writeLedger(marks);
        delivered.push(...pendingKinds);
      }
    } else {
      let inputs;
      if (provider === "claude")
        inputs = [
          ...document.querySelectorAll(
            'input[data-testid="file-upload"][type="file"]',
          ),
        ];
      else {
        inputs = [...root().querySelectorAll('input[type="file"]')];
        if (!inputs.length)
          inputs = [...document.querySelectorAll('input[type="file"]')].filter(
            (node) => !node.closest("form"),
          );
      }
      // ChatGPT also exposes image-only inputs. Require both PNG and TXT support
      // so PNG-only, TXT-only, and PNG+TXT consistently use its general control.
      const requirePngAccept = provider === "chatgpt" || needPng;
      const requireTxtAccept = provider === "chatgpt" || needTxt;
      const input = validateInput(
        inputs.filter(
          (node) =>
            (!requirePngAccept || accepts(node, ".png", "image/png")) &&
            (!requireTxtAccept || accepts(node, ".txt", "text/plain")),
        ),
      );
      const batch = [...(png ? [png] : []), ...(txt ? [txt] : [])];
      upload(input, batch, pendingKinds);
      const marks = {};
      for (const kind of pendingKinds) marks[kind] = "prepared";
      writeLedger(marks);
      delivered.push(...pendingKinds);
    }

    // Success means handoff succeeded; the provider uploads and processes independently.
    return { prepared: true, delivered: [...requestedKinds] };
  } catch (error) {
    const failedKinds = pendingKinds.filter((kind) => !delivered.includes(kind));
    return {
      prepared: false,
      needsReview: changed || userEdited,
      delivered: [...delivered],
      failedKinds,
      error: error.message,
    };
  } finally {
    if (provider === "gemini") closeGeminiMenu();
    for (const event of events)
      document.removeEventListener(event, observeEdit, true);
    if (locked && globalThis.__pageCapturePreparing === payload.deliveryId)
      delete globalThis.__pageCapturePreparing;
  }
}
