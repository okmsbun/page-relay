/* Stable identity and TXT bytes for one captured page. No composer text is generated. */
const CapturePreparation = (() => {
  const captures = new WeakMap();
  function payload(destination, capture) {
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
    return { ...files, providerId: destination.providerId, expectedUrl: destination.url, deadline: Date.now() + 140000 };
  }
  return { payload };
})();

/* Self-contained: Chrome serializes this function into the selected tab's isolated
   world. Never edits the text editor, restores a draft, or activates a send control. */
async function prepareFilesInComposer(payload) {
  const provider = payload.providerId;
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const visible = (node) => node && !node.closest('[hidden], [inert], [aria-hidden="true"]') &&
    node.getClientRects().length > 0 && getComputedStyle(node).visibility !== "hidden";
  const url = () => `${location.origin}${location.pathname.replace(/\/+$/, "") || "/"}${location.search}`;
  const selectors = {
    chatgpt: '#prompt-textarea, form[data-chatgpt-composer] [data-composer-markdown][contenteditable="true"]',
    claude: '[data-testid="chat-input"][contenteditable="true"]',
    gemini: 'rich-textarea [contenteditable="true"][role="textbox"]',
  };
  const editor = () => {
    const nodes = [...document.querySelectorAll(selectors[provider])].filter(visible);
    return nodes.length === 1 ? nodes[0] : null;
  };
  const root = () => editor()?.closest(provider === "chatgpt" ? "form" :
    provider === "claude" ? '[data-cds="ChatComposer"]' : '[data-node-type="input-area"]');
  const textState = (node) => node instanceof HTMLTextAreaElement ? node.value : node.innerHTML;
  const metadata = (node) => {
    const nodes = [node, ...node.querySelectorAll('[title], [aria-label], [aria-describedby], img[alt]')];
    return [node.innerText || "", ...nodes.filter(visible).flatMap((element) => [
      element.getAttribute("title") || "", element.getAttribute("aria-label") || "",
      element.getAttribute("alt") || "",
      ...(element.getAttribute("aria-describedby") || "").split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent || ""),
    ])].join(" ");
  };
  const filenameMatches = (node, name) => {
    const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const dot = name.lastIndexOf(".");
    const ext = provider === "gemini" && name === payload.png ? "\\.(?:png|jpe?g)" : escape(name.slice(dot));
    const suffix = provider === "gemini" && name === payload.png ? "(?:_[a-zA-Z0-9-]+)?" : "";
    return new RegExp("(?:^|\\s)" + escape(name.slice(0, dot)) + suffix + ext + "(?=\\s|$)", "i").test(metadata(node));
  };
  const tiles = () => {
    const container = root();
    if (!container) return [];
    let nodes;
    if (provider === "gemini") nodes = [...container.querySelectorAll("uploader-file-preview")];
    else if (provider === "claude") nodes = [...container.querySelectorAll('[data-testid="file-thumbnail"], [data-cds-attachment]')];
    else {
      nodes = [...container.querySelectorAll('[data-testid*="file-thumbnail"], [data-file-id], .group\\/composer-attachment')];
      for (const button of container.querySelectorAll('button[aria-label]')) {
        if (!visible(button) || !/^remove\s+|(?:file|attachment|image).*remove/i.test(button.getAttribute("aria-label"))) continue;
        if (!nodes.some((node) => node.contains(button))) nodes.push(button.parentElement);
      }
      for (const node of container.querySelectorAll('[data-testid*="attachment"]')) {
        if (node.matches('button, input, [role="button"]')) continue;
        if (/(?:^|\s)[^\s/\\]+\.[a-z0-9]{1,12}(?=\s|$)/i.test(metadata(node)) || node.querySelector('img[src]')) nodes.push(node);
      }
    }
    // Keep the innermost tile if a provider wraps tiles in an attachment container.
    const unique = [...new Set(nodes)].filter((node) => node !== container && visible(node));
    return unique.filter((node) => !unique.some((child) => child !== node && node.contains(child)));
  };
  const identity = (node) => {
    // Prefer stable file identity over DOM node identity (providers replace nodes).
    const fileId = node.getAttribute("data-file-id");
    if (fileId) return `id:${fileId}`;
    const values = [node, ...node.querySelectorAll('[title], [aria-label], [aria-describedby], img[alt]')]
      .filter(visible).flatMap((element) => [
        element.getAttribute("title"), element.getAttribute("aria-label"), element.getAttribute("alt"),
        ...(element.getAttribute("aria-describedby") || "").split(/\s+/).map((id) => document.getElementById(id)?.textContent),
      ]).filter(Boolean).filter((value) => !/^(remove|close)(\s|$)/i.test(value));
    const names = [...new Set(values)].sort();
    const images = [...node.querySelectorAll("img[src]")].map((image) => image.getAttribute("src"));
    const label = names.length ? names : (node.innerText || "").trim();
    return label.length || images.length ? JSON.stringify([label, images]) : null;
  };
  const progress = () => [...(root()?.querySelectorAll('[role="progressbar"], [aria-busy="true"], [data-cds="Spinner"]') || [])].some(visible);
  const errorVisible = () => [...document.querySelectorAll('[role="alert"], mat-error')].some((node) => visible(node) && node.innerText.trim());
  const consent = () => provider === "gemini" && !!document.querySelector("upload-image-disclaimer-dialog");
  const ledger = globalThis.__pageRelayPreparations ||= new Map();
  const key = `${payload.expectedUrl}:${payload.deliveryId}`;
  let changed = false, locked = false, userEdited = false, initialText, initial = [];
  const observeEdit = (event) => {
    if (event.isTrusted && (event.target.closest?.(selectors[provider]) || event.target.matches?.('input[type="file"]'))) userEdited = true;
  };
  const events = ["beforeinput", "input", "paste", "drop", "compositionstart"];
  const pairReady = () => {
    const current = tiles();
    const images = current.filter((node) => filenameMatches(node, payload.png));
    const texts = current.filter((node) => filenameMatches(node, payload.txt));
    const image = images[0]?.querySelector("img");
    return images.length === 1 && texts.length === 1 && images[0] !== texts[0] &&
      !progress() && (provider !== "gemini" || (image?.complete && image.naturalWidth > 0));
  };
  function check() {
    if (Date.now() >= payload.deadline) throw new Error("Preparation timed out. Review this chat before adding again.");
    if (url() !== payload.expectedUrl) throw new Error("The conversation changed. Review this chat.");
    const current = editor();
    if (!current || userEdited || textState(current) !== initialText)
      throw new Error("The user draft changed while adding files. Nothing will be overwritten. Review this chat.");
    const currentTiles = tiles();
    const available = [...currentTiles];
    for (const old of initial) {
      const index = available.findIndex((node) => old.key ? identity(node) === old.key : node === old.node);
      if (index < 0) throw new Error("An existing attachment changed or disappeared. Review this chat; PageRelay will not retry.");
      available.splice(index, 1);
    }
    if (available.length > 2)
      throw new Error("Attachments changed while adding files. Review this chat.");
    if (consent()) throw new Error("Open Gemini and review its upload consent dialog, then retry.");
    if (errorVisible()) throw new Error("The provider is showing an error. Review this chat and its upload status.");
  }
  async function until(predicate, duration = 60000, stableFor = 0) {
    const deadline = Math.min(payload.deadline, Date.now() + duration);
    let since = null;
    while (Date.now() < deadline) {
      check();
      if (predicate()) {
        since ??= Date.now();
        if (Date.now() - since >= stableFor) return true;
      } else since = null;
      await wait(250);
    }
    return false;
  }
  function accepts(input, extension, mime) {
    return !input.accept || input.accept.toLowerCase().split(",").map((value) => value.trim())
      .some((value) => ["*", "*/*", extension, mime, mime.split("/")[0] + "/*"].includes(value));
  }
  function validateInput(nodes) {
    if (nodes.length !== 1 || nodes[0].disabled || !nodes[0].multiple)
      throw new Error("The upload control is unavailable or changed. No further files were added.");
    const input = nodes[0];
    // Never replace an unresolved native selection. Already rendered, ready files
    // belong to provider state and are not copied into the new upload batch.
    if ([...(input.files || [])].some((file) => !tiles().some((tile) => filenameMatches(tile, file.name))))
      throw new Error("A file selection has not finished loading. Wait for its attachments to appear, then retry.");
    return input;
  }
  async function geminiInput(selector) {
    check();
    let nodes = [...document.querySelectorAll(selector)];
    if (!nodes.length) {
      const toggle = root()?.querySelector('simplified-input-menu button[aria-haspopup="menu"]');
      if (!visible(toggle)) throw new Error("Gemini’s upload menu is unavailable. Open the tab, then retry.");
      if (toggle.getAttribute("aria-expanded") !== "true") toggle.click();
      if (!await until(() => { nodes = [...document.querySelectorAll(selector)]; return nodes.length > 0; }, 10000))
        throw new Error("Gemini’s upload control did not appear.");
    }
    return validateInput(nodes);
  }
  function upload(input, files) {
    check();
    const data = new DataTransfer();
    for (const file of files) data.items.add(file);
    changed = true;
    ledger.set(key, "review"); // Retained even if the tab/panel interrupts execution.
    input.files = data.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
    check();
  }
  try {
    if (!selectors[provider]) throw new Error("Unsupported provider.");
    if (url() !== payload.expectedUrl) throw new Error("The conversation changed. Refresh and select it again.");
    if (globalThis.__pageCapturePreparing) return { prepared: false, needsReview: false, busy: true, error: "Another capture is being prepared in this tab. Wait, then retry." };
    if (ledger.get(key) === "review") return { prepared: false, needsReview: true, error: "This capture was already attempted. Review the existing files before adding again." };
    if (!editor() || !root()) throw new Error("The message composer is unavailable. Open this chat and sign in.");
    const stop = provider === "chatgpt" ? '[data-testid="stop-button"]' : provider === "claude" ? '[data-testid="stop-response"]' : 'gem-icon-button.send-button.stop, .stop-button';
    if ([...document.querySelectorAll(stop)].some(visible)) return { prepared: false, needsReview: false, busy: true, error: "Generating a response. Wait for it to finish, then click Add again." };
    if (progress()) return { prepared: false, needsReview: false, busy: true, error: "Existing attachments are still uploading. Wait, then click Add again." };
    initialText = textState(editor());
    initial = tiles().map((node) => ({ node, key: identity(node) }));
    check();
    globalThis.__pageCapturePreparing = payload.deliveryId;
    locked = true;
    for (const event of events) document.addEventListener(event, observeEdit, true);
    // DOM evidence also protects a repeated operation after the isolated world's
    // ledger was lost. Never re-upload a partial pair or a previously added capture.
    if (ledger.has(key) || tiles().some((node) => filenameMatches(node, payload.png) || filenameMatches(node, payload.txt))) {
      changed = true; // Uncertainty about a previous upload must remain Needs review.
      if (!pairReady()) throw new Error("This capture was already added or partially prepared. Review its files before adding again.");
      if (!await until(pairReady, 2000, 1000)) throw new Error("Previously prepared attachments changed. Review this chat.");
      ledger.set(key, "prepared");
      return { prepared: true, duplicate: true };
    }
    if (!payload.screenshot?.startsWith("data:image/png;base64,")) throw new Error("The captured screenshot is not a PNG.");
    const bytes = Uint8Array.from(atob(payload.screenshot.split(",")[1]), (character) => character.charCodeAt(0));
    const png = new File([bytes], payload.png, { type: "image/png" });
    const txt = new File([payload.text], payload.txt, { type: "text/plain" });
    if (provider === "gemini") {
      const imageInput = await geminiInput('uploader input[type="file"][accept="image/*"]');
      upload(imageInput, [png]);
      if (!await until(() => tiles().some((tile) => filenameMatches(tile, payload.png))))
        throw new Error("Screenshot upload could not be confirmed. Review this chat.");
      const textInput = await geminiInput('images-files-uploader input[type="file"]');
      if (!accepts(textInput, ".txt", "text/plain")) throw new Error("Gemini’s upload control does not accept TXT files.");
      upload(textInput, [txt]);
    } else {
      let inputs;
      if (provider === "claude") inputs = [...document.querySelectorAll('input[data-testid="file-upload"][type="file"]')];
      else {
        inputs = [...root().querySelectorAll('input[type="file"]')];
        if (!inputs.length) inputs = [...document.querySelectorAll('input[type="file"]')].filter((node) => !node.closest("form"));
      }
      const input = validateInput(inputs.filter((node) => accepts(node, ".png", "image/png") && accepts(node, ".txt", "text/plain")));
      upload(input, [png, txt]);
    }
    const prepared = () => pairReady() && tiles().length === initial.length + 2;
    if (!await until(prepared, 60000, 1000)) throw new Error("The two attachments did not become ready. Review this chat’s upload status.");
    ledger.set(key, "prepared");
    return { prepared: true };
  } catch (error) {
    return { prepared: false, needsReview: changed || userEdited, error: error.message };
  } finally {
    for (const event of events) document.removeEventListener(event, observeEdit, true);
    if (locked && globalThis.__pageCapturePreparing === payload.deliveryId) delete globalThis.__pageCapturePreparing;
  }
}
