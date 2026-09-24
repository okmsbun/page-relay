/* Gemini integration only. Selectors observed in the signed-in web composer.
   Preparation only: attachments and prompt are left in the composer for the user to
   review and submit. This extension never submits, presses Enter, or starts generation.
   Never accepts consent dialogs or opens native file pickers automatically. */
async function prepareInGemini(destination, capture) {
  await ChatDestinations.validate(destination);
  const deliveryId = crypto.randomUUID();
  const payload = {
    expectedUrl: destination.url,
    deliveryId,
    screenshot: capture.screenshot,
    text: capture.text,
    png: `page-${deliveryId}.png`,
    txt: `page-${deliveryId}.txt`,
    prompt: `Captured page context [${deliveryId}]\n${capture.title || "Untitled page"}\n${capture.url || ""}\nUse the attached screenshot and extracted page text.${capture.truncated ? " The extracted text reached the capture size limit." : ""}`,
  };
  let result;
  const [previous] = await chrome.tabs.query({
    active: true,
    windowId: destination.windowId,
  });
  let activated = false;
  let injectionStarted = false;
  try {
    if (previous?.id !== destination.id) {
      await chrome.tabs.update(destination.id, { active: true });
      activated = true;
    }
    await ChatDestinations.validate(destination);
    injectionStarted = true;
    const results = await chrome.scripting.executeScript({
      target: { tabId: destination.id },
      func: prepareInGeminiComposer,
      args: [payload],
    });
    result = results[0]?.result;
  } catch (error) {
    error.needsReview = injectionStarted;
    throw error;
  } finally {
    if (activated && previous?.id) {
      // Do not override a tab switch the user made while preparing.
      try {
        const [current] = await chrome.tabs.query({
          active: true,
          windowId: destination.windowId,
        });
        if (current?.id === destination.id)
          await chrome.tabs.update(previous.id, { active: true });
      } catch {
        /* The old tab/window may have closed; preserve the preparation result. */
      }
    }
  }
  if (result?.prepared) return result;
  const error = new Error(
    result?.error || "The capture could not be prepared in this Gemini chat.",
  );
  error.needsReview = result?.needsReview ?? true;
  error.busy = result?.busy === true && result.needsReview === false;
  throw error;
}

async function prepareInGeminiComposer(payload) {
  let changed = false;
  let ownEdit = false;
  let userEdited = false;
  let draftChanged = false;
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const normalize = (text) =>
    text
      .replace(/[\u200B\uFEFF]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  const visible = (node) =>
    node &&
    node.getClientRects().length > 0 &&
    getComputedStyle(node).visibility !== "hidden";
  const url = () =>
    `${location.origin}${location.pathname.replace(/\/+$/, "") || "/"}${location.search}`;
  const editor = () => {
    const nodes = [
      ...document.querySelectorAll(
        'rich-textarea [contenteditable="true"][role="textbox"]',
      ),
    ].filter(visible);
    return nodes.length === 1 ? nodes[0] : null;
  };
  const root = () => editor()?.closest('[data-node-type="input-area"]');
  const consent = () =>
    !!document.querySelector("upload-image-disclaimer-dialog");
  const errorVisible = () =>
    [...document.querySelectorAll('[role="alert"],mat-error')].some(
      (node) => visible(node) && node.innerText.trim(),
    );
  const metadata = (node) =>
    (node?.textContent || "") +
    [
      ...(node?.querySelectorAll("[title],[aria-label],[aria-describedby]") ||
        []),
    ]
      .map((element) =>
        [
          element.getAttribute("title"),
          element.getAttribute("aria-label"),
          ...(element.getAttribute("aria-describedby") || "")
            .split(/\s+/)
            .map((id) => document.getElementById(id)?.textContent || ""),
        ].join(" "),
      )
      .join(" ");
  const filenameMatches = (node, name) => {
    const text = metadata(node);
    if (text.includes(name)) return true;
    // Gemini adds a generated suffix to uploaded image filenames.
    const dot = name.lastIndexOf(".");
    const stem = name.slice(0, dot).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const ext = name.slice(dot).replace(".", "\\.");
    return new RegExp(stem + "_[a-zA-Z0-9-]+" + ext + "(?:\\s|$)").test(text);
  };
  const previews = () => [
    ...(root()?.querySelectorAll("uploader-file-preview") || []),
  ];
  const onEdit = (event) => {
    if (
      !ownEdit &&
      event.isTrusted &&
      event.target.closest?.('rich-textarea [role="textbox"]')
    )
      userEdited = true;
  };
  const events = ["beforeinput", "input", "paste", "drop", "compositionstart"];
  function checkDraft(expected) {
    if (
      url() !== payload.expectedUrl ||
      userEdited ||
      !editor() ||
      normalize(editor().innerText) !== normalize(expected)
    ) {
      throw new Error(
        "The draft changed while preparing attachments. Review this Gemini chat.",
      );
    }
    if (consent())
      throw new Error(
        "Open Gemini and review its image/file upload consent dialog, then retry.",
      );
    if (errorVisible())
      throw new Error(
        "Gemini is showing an error. Check this chat before retrying.",
      );
  }
  async function uploadInput(selector) {
    checkDraft("");
    let nodes = [...document.querySelectorAll(selector)];
    if (!nodes.length) {
      const toggle = root()?.querySelector(
        'simplified-input-menu button[aria-haspopup="menu"]',
      );
      if (!visible(toggle))
        throw new Error(
          "Gemini’s upload menu is unavailable. Open the tab to finish loading, then retry.",
        );
      if (toggle.getAttribute("aria-expanded") !== "true") toggle.click();
      const deadline = Date.now() + 10000;
      while (!nodes.length && Date.now() < deadline) {
        await wait(250);
        checkDraft("");
        nodes = [...document.querySelectorAll(selector)];
      }
    }
    if (nodes.length !== 1 || nodes[0].disabled || !nodes[0].multiple)
      throw new Error(
        "Gemini’s upload control is unavailable or changed. Open this tab, then retry.",
      );
    if (nodes[0].files?.length)
      throw new Error(
        "This chat already has files selected. Send or remove them first.",
      );
    return nodes[0];
  }
  // Prepared means the site accepted both attachments and our prompt as a draft the user
  // can review and submit: both upload tiles render with a decoded image, no upload is in
  // progress, the composer holds exactly our prompt, and the send control is usable.
  const isPrepared = () => {
    const container = root();
    if (!container) return false;
    const tiles = previews();
    const image = tiles
      .find((tile) => filenameMatches(tile, payload.png))
      ?.querySelector("img");
    const send = container.querySelector(
      "gem-icon-button.send-button.submit button",
    );
    return (
      tiles.length === 2 &&
      image?.complete &&
      image.naturalWidth > 0 &&
      tiles.some((tile) => filenameMatches(tile, payload.txt)) &&
      ![
        ...container.querySelectorAll(
          '[role="progressbar"],[aria-busy="true"]',
        ),
      ].some(visible) &&
      normalize(editor().innerText) === normalize(payload.prompt) &&
      visible(send) &&
      !send.disabled &&
      send.getAttribute("aria-disabled") !== "true"
    );
  };
  // Waits for a prepared composer that stays prepared. A brief re-render of the draft is
  // tolerated; a draft that stops holding our prompt is reported for review immediately.
  // Nothing here ever submits.
  async function waitUntilPrepared(duration, stableFor) {
    const deadline = Date.now() + duration;
    let since = 0;
    let mismatchedSince = 0;
    while (Date.now() < deadline) {
      await wait(250);
      const composer = editor();
      const mismatch =
        !composer ||
        url() !== payload.expectedUrl ||
        normalize(composer.innerText) !== normalize(payload.prompt);
      if (mismatch) {
        mismatchedSince ||= Date.now();
        since = 0;
        if (userEdited || Date.now() - mismatchedSince >= 2000) {
          draftChanged = true;
          throw new Error(
            "The draft changed while preparing attachments. Review this Gemini chat.",
          );
        }
        continue;
      }
      mismatchedSince = 0;
      if (errorVisible())
        throw new Error(
          "Gemini is showing an error. Check this chat before retrying.",
        );
      if (isPrepared()) {
        since ||= Date.now();
        if (Date.now() - since >= stableFor) return true;
      } else since = 0;
    }
    return false;
  }
  try {
    if (url() !== payload.expectedUrl)
      throw new Error(
        "This conversation changed. Refresh and select it again.",
      );
    if (globalThis.__pageCapturePreparing)
      throw new Error("A capture is already being prepared in this tab.");
    if (!editor() || !root())
      throw new Error(
        "Gemini’s composer is unavailable. Open the chat and sign in.",
      );
    if (normalize(editor().innerText))
      throw new Error("This chat has an unsent draft. Send or clear it first.");
    if (previews().length)
      throw new Error(
        "This chat already has attachments. Send or remove them first.",
      );
    checkDraft("");
    if (root().querySelector("gem-icon-button.send-button.stop, .stop-button"))
      return {
        prepared: false,
        busy: true,
        needsReview: false,
        error:
          "Generating a response. Nothing was prepared. Wait for it to finish, then click Add again.",
      };
    if (!payload.screenshot.startsWith("data:image/png;base64,"))
      throw new Error("The captured screenshot is not a PNG.");
    const bytes = Uint8Array.from(
      atob(payload.screenshot.split(",")[1]),
      (character) => character.charCodeAt(0),
    );
    globalThis.__pageCapturePreparing = payload.deliveryId;
    for (const event of events) document.addEventListener(event, onEdit, true);
    const imageInput = await uploadInput(
      'uploader input[type="file"][accept="image/*"]',
    );
    checkDraft("");
    const png = new DataTransfer();
    png.items.add(new File([bytes], payload.png, { type: "image/png" }));
    changed = true;
    imageInput.files = png.files;
    imageInput.dispatchEvent(new Event("change", { bubbles: true }));
    let deadline = Date.now() + 60000;
    while (
      !previews().some((preview) => filenameMatches(preview, payload.png))
    ) {
      if (Date.now() >= deadline)
        throw new Error(
          "Screenshot upload could not be confirmed. Review this chat.",
        );
      await wait(250);
      checkDraft("");
    }
    const textInput = await uploadInput(
      'images-files-uploader input[type="file"]',
    );
    if (!textInput.accept.split(",").includes(".txt"))
      throw new Error("Gemini’s file control does not accept extracted text.");
    checkDraft("");
    const txt = new DataTransfer();
    txt.items.add(
      new File([payload.text || ""], payload.txt, { type: "text/plain" }),
    );
    textInput.files = txt.files;
    textInput.dispatchEvent(new Event("change", { bubbles: true }));
    checkDraft("");
    ownEdit = true;
    editor().focus();
    const inserted = document.execCommand("insertText", false, payload.prompt);
    ownEdit = false;
    if (!inserted)
      throw new Error(
        "Could not fill Gemini’s composer. Review the attached files.",
      );
    if (await waitUntilPrepared(60000, 1000)) return { prepared: true };
    throw new Error(
      draftChanged
        ? "The draft changed while preparing attachments. Review this Gemini chat."
        : "Gemini’s attachments did not become ready. Review the draft.",
    );
  } catch (error) {
    return { prepared: false, needsReview: changed, error: error.message };
  } finally {
    for (const event of events)
      document.removeEventListener(event, onEdit, true);
    if (globalThis.__pageCapturePreparing === payload.deliveryId)
      delete globalThis.__pageCapturePreparing;
  }
}
