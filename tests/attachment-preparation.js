(async () => {
  const nativeNow = Date.now.bind(Date), nativeTimeout = setTimeout.bind(window);
  Date.now = () => nativeNow() * 100;
  window.setTimeout = (fn, ms) => nativeTimeout(fn, Math.max(1, ms / 100));
  const provider = new URLSearchParams(location.search).get("provider") || "chatgpt";
  const checks = [];
  const assert = (ok, label) => { if (!ok) throw new Error(label); checks.push(label); };
  const fixture = document.getElementById("fixture");
  const canvas = document.createElement("canvas"); canvas.width = canvas.height = 8;
  const screenshot = canvas.toDataURL();
  let edits = 0, keys = 0, submissions = 0;
  document.execCommand = () => { edits++; throw new Error("Composer editing is forbidden"); };
  const nativeDispatch = EventTarget.prototype.dispatchEvent;
  EventTarget.prototype.dispatchEvent = function (event) {
    if (/^key(down|press|up)$/.test(event.type)) keys++;
    return nativeDispatch.call(this, event);
  };
  document.addEventListener("submit", (event) => { event.preventDefault(); submissions++; }, true);
  const prepare = { chatgpt: prepareCaptureInComposer, claude: prepareInClaudeComposer, gemini: prepareInGeminiComposer }[provider];
  async function run(mode, includeText, truncated = false) {
    const editorMarkup = provider === "chatgpt" ? '<div id="prompt-textarea" contenteditable="true" style="min-height:30px"></div>' : provider === "claude" ? '<div data-testid="chat-input" contenteditable="true" style="min-height:30px"></div>' : '<rich-textarea><div role="textbox" contenteditable="true" style="min-height:30px"></div></rich-textarea>';
    const inputMarkup = provider === "gemini"
      ? '<uploader><input type="file" multiple accept="image/*"><images-files-uploader><input type="file" multiple accept=".txt,.pdf"></images-files-uploader></uploader>'
      : provider === "claude"
        ? '<input type="file" multiple data-testid="file-upload">'
        : '<input type="file" multiple accept="image/*" data-testid="image-upload">' +
          '<input type="file" multiple accept="image/*,.txt,.pdf" data-testid="general-upload">' +
          (mode === "ambiguous-general" ? '<input type="file" multiple accept="image/*,.txt,.pdf" data-testid="second-general-upload">' : '');
    fixture.innerHTML = `<${provider === "chatgpt" ? 'form' : 'div'} ${provider === "claude" ? 'data-cds="ChatComposer"' : provider === "gemini" ? 'data-node-type="input-area"' : ''}>${editorMarkup}${inputMarkup}<div id="tiles"></div><button type="button" id="send" disabled>Send</button><simplified-input-menu><button type="button" aria-haspopup="menu">Upload</button></simplified-input-menu></${provider === "chatgpt" ? 'form' : 'div'}>`;
    const editor = () => fixture.querySelector('[contenteditable="true"]');
    const container = fixture.firstElementChild;
    const tiles = fixture.querySelector("#tiles");
    const capture = { screenshot, title: "Example Page", url: "https://example.com/page", text: "Rendered text\nRepeat\nRepeat", truncated, includeText };
    const destination = { providerId: provider, url: location.origin + location.pathname + location.search };
    const payload = CapturePreparation.payload(destination, capture);
    assert(includeText || payload.text === undefined, "text-off payload does not expose extracted text to provider tab");
    const uploaded = [], usedInputs = [];
    let changes = 0;
    function tile(name, image = false) {
      const node = document.createElement(provider === "gemini" ? "uploader-file-preview" : "div");
      node.style.display = "inline-block";
      if (provider !== "gemini") node.dataset.testid = "file-thumbnail";
      const label = document.createElement("span"); label.title = name; label.textContent = name;
      if (provider === "gemini" && image && name === payload.png) {
        const tip = document.createElement("div"); tip.hidden = true; tip.id = "tip-" + payload.deliveryId;
        tip.textContent = name.replace(".png", "_e2b59e.jpg"); fixture.append(tip);
        label.title = ""; label.textContent = ""; label.setAttribute("aria-describedby", tip.id);
      }
      node.append(label);
      if (image) { const img = document.createElement("img"); img.src = screenshot; node.append(img); }
      tiles.append(node); return node;
    }
    const existing = ["attachment", "both", "multiple", "removed-existing", "rerender-existing", "selected-acknowledged", "changed-image"].includes(mode);
    if (["text", "both"].includes(mode)) editor().innerHTML = '<p><b>User draft</b> &nbsp; exactly</p><p>Second line</p>';
    const initialText = editor().innerHTML;
    if (existing) tile("personal.pdf", mode === "changed-image");
    if (mode === "multiple") { tile("personal.png", true); tile("notes.txt"); }
    const original = [...tiles.children];
    if (mode === "empty-ui" && provider === "chatgpt") {
      const ui = document.createElement("div"); ui.dataset.testid = "attachments";
      ui.innerHTML = '<button type="button" data-testid="attachment-button">Attach files</button><span title="stale.pdf" hidden>stale.pdf</span>';
      container.append(ui);
    }
    if (mode === "modern" && provider === "chatgpt") { editor().removeAttribute("id"); editor().setAttribute("data-composer-markdown", ""); container.setAttribute("data-chatgpt-composer", ""); }
    const inputs = [...fixture.querySelectorAll('input[type="file"]')];
    if (provider === "chatgpt") assert(inputs.length >= 2 && inputs[0].dataset.testid === "image-upload", "ChatGPT fixture has an image-only control before the general uploader");
    if (["unresolved-selection", "selected-acknowledged"].includes(mode)) {
      const dt = new DataTransfer(); dt.items.add(new File(["private"], "personal.pdf"));
      (provider === "chatgpt" ? inputs.find((input) => input.dataset.testid === "general-upload") : inputs[0]).files = dt.files;
    }
    for (const input of inputs) input.addEventListener("change", () => {
      changes++;
      usedInputs.push(input.dataset.testid || provider);
      if (mode === "removed-existing") tiles.replaceChildren();
      for (const file of input.files) {
        uploaded.push(file);
        if (mode === "missing-file" && file.type === (includeText ? "text/plain" : "image/png")) continue;
        if (mode === "wrong-name") tile("unrelated-" + file.name, file.type === "image/png");
        else tile(file.name, file.type === "image/png");
      }
      input.value = "";
      if (mode === "replace-editor") editor().replaceWith(editor().cloneNode(true));
      if (mode === "rerender-existing") original[0]?.replaceWith(original[0].cloneNode(true));
      if (mode === "changed-image") original[0].querySelector("img").src = screenshot + "#changed";
      if (mode === "extra-attachment") tile("user-added-during-upload.pdf");
      if (mode === "edit") editor().textContent = "User edited during preparation";
      if (mode === "upload-error") { const error = document.createElement("div"); error.setAttribute("role", "alert"); error.textContent = "Upload failed"; container.append(error); }
      if (mode === "progress") { const progress = document.createElement("div"); progress.setAttribute("role", "progressbar"); progress.textContent = "Uploading"; container.append(progress); setTimeout(() => progress.remove(), 600); }
    });
    fixture.querySelector("#send").addEventListener("click", () => submissions++);
    if (mode === "no-send") fixture.querySelector("#send").remove();
    if (mode === "wrong-url") payload.expectedUrl += "/changed";
    if (mode === "busy") {
      const stop = document.createElement("button"); stop.type = "button"; stop.textContent = "Stop";
      if (provider === "gemini") stop.className = "stop-button"; else stop.dataset.testid = provider === "chatgpt" ? "stop-button" : "stop-response";
      container.append(stop);
    }
    if (mode === "consent" && provider === "gemini") fixture.append(document.createElement("upload-image-disclaimer-dialog"));
    if (mode === "invalid-png") payload.screenshot = "data:text/plain;base64,aGVsbG8=";
    if (mode === "no-input") inputs.forEach((input) => input.remove());
    if (mode === "no-text-input" && provider === "gemini") inputs[1].remove();
    if (mode === "disabled-input") inputs.forEach((input) => input.disabled = true);
    const running = prepare(payload);
    let concurrent;
    if (mode === "concurrent") concurrent = await prepare({ ...payload, deliveryId: "competing-operation" });
    const result = await running;
    if (mode === "concurrent") assert(concurrent.busy && !concurrent.needsReview, "same tab cannot prepare competing operations");
    return { result, uploaded, usedInputs, changes, payload, capture, initialText, draft: editor().innerHTML, existingPresent: !existing || tiles.textContent.includes("personal.pdf"), count: tiles.children.length, initialCount: original.length, repeat: () => prepare({ ...payload, deadline: Date.now() + 140000 }), currentChanges: () => changes, forget: () => globalThis.__pageRelayPreparations.clear(), removeOwn: () => tiles.lastElementChild.remove() };
  }
  try {
    for (const includeText of [false, true]) {
    for (const mode of ["empty", "text", "attachment", "both", "multiple", "no-send", "replace-editor", "rerender-existing", "selected-acknowledged", "progress", "empty-ui", "modern", "concurrent", ...(provider === "gemini" && !includeText ? ["no-text-input"] : [])]) {
      const value = await run(mode, includeText, mode === "multiple");
      assert(value.result.prepared, mode + ": prepared (" + JSON.stringify(value.result) + ")");
      assert(value.draft === value.initialText && value.existingPresent, mode + ": existing rich text and attachments preserved");
      assert(value.uploaded.length === (includeText ? 2 : 1) && value.uploaded[0].type === "image/png" && (!includeText || value.uploaded[1].type === "text/plain"), mode + ": exactly the expected new files, no old files reuploaded");
      if (provider === "chatgpt") assert(value.usedInputs.length === 1 && value.usedInputs[0] === "general-upload", mode + ": ChatGPT uses only the general uploader");
      assert(value.count === value.initialCount + (includeText ? 2 : 1), mode + ": attachment count rises by expected number");
      if (includeText) {
        const txt = await value.uploaded[1].text();
        assert(txt === value.payload.text && txt.startsWith("Page title: Example Page\nURL: https://example.com/page\n") && txt.endsWith(value.capture.text), mode + ": TXT metadata and original body bytes are correct");
        assert(!txt.includes(value.payload.deliveryId) && txt.includes("truncated") === value.capture.truncated, mode + ": truncation only when applicable, no internal ID in TXT");
      }
      const again = await value.repeat();
      assert(again.prepared && again.duplicate && value.currentChanges() === value.changes, mode + ": repeated preparation never reuploads (" + JSON.stringify(again) + ")");
    }
    for (const mode of ["edit", "removed-existing", "upload-error", "missing-file", "wrong-name", "changed-image", "extra-attachment"]) {
      const value = await run(mode, includeText);
      assert(!value.result.prepared && value.result.needsReview, mode + ": uncertainty ends with review");
      const count = value.changes; await value.repeat();
      assert(value.currentChanges() === count, mode + ": uncertain attempts cannot duplicate partial uploads");
      if (mode === "edit") assert(value.draft === "User edited during preparation", "user edits are never restored or overwritten");
    }
    for (const mode of ["wrong-url", "unresolved-selection", "invalid-png", "disabled-input", "no-input", ...(provider === "gemini" ? ["consent"] : []), ...(provider === "chatgpt" ? ["ambiguous-general"] : [])]) {
      const value = await run(mode, includeText);
      assert(!value.result.prepared && !value.result.needsReview && !value.changes, mode + ": unsafe preflight fails before upload");
      if (mode === "ambiguous-general") assert(value.result.error.includes("upload control is unavailable or changed"), "ambiguous general uploaders fail safely");
    }
    const recovered = await run("both", includeText);
    recovered.forget();
    const existingPair = await recovered.repeat();
    assert(existingPair.prepared && existingPair.duplicate && recovered.currentChanges() === recovered.changes, "existing own file pair protects against duplicate after ledger loss");
    recovered.removeOwn();
    const missingPair = await recovered.repeat();
    assert(!missingPair.prepared && missingPair.needsReview && recovered.currentChanges() === recovered.changes, "previous success never silently re-adds a removed file");
    const busy = await run("busy", includeText);
    assert(busy.result.busy && busy.result.needsReview === false && busy.changes === 0, "generation stays retryable Busy before mutation");
    }
    assert(!globalThis.__pageCapturePreparing, "per-tab lock released");
    assert(edits === 0 && keys === 0 && submissions === 0, "no composer writes, Send clicks, form submissions or key simulation");
    document.getElementById("result").textContent = "PASS " + JSON.stringify(checks);
  } catch (error) { document.getElementById("result").textContent = "FAIL " + error.message + " " + JSON.stringify(checks); }
})();
