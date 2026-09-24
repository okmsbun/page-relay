/* Claude integration only. Uses the signed-in UI, not private APIs or cookies.
   Preparation only: attachments and prompt are left in the composer for the user to
   review and submit. This extension never submits, presses Enter, or starts generation. */
async function prepareInClaude(destination, capture) {
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
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: destination.id },
      func: prepareInClaudeComposer,
      args: [payload],
    });
    result = results[0]?.result;
  } catch (error) {
    error.needsReview = true;
    throw error;
  }
  if (result?.prepared) return result;
  const error = new Error(
    result?.error || "The capture could not be prepared in this Claude chat.",
  );
  error.needsReview = result?.needsReview ?? true;
  error.busy = result?.busy === true && result.needsReview === false;
  throw error;
}

async function prepareInClaudeComposer(payload) {
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
        '[data-testid="chat-input"][contenteditable="true"]',
      ),
    ].filter(visible);
    return nodes.length === 1 ? nodes[0] : null;
  };
  const root = () => editor()?.closest('[data-cds="ChatComposer"]');
  const metadata = (node) =>
    (node?.innerText || "") +
    [...(node?.querySelectorAll("[title],[aria-label],img[alt]") || [])]
      .map((element) =>
        [
          element.getAttribute("title"),
          element.getAttribute("aria-label"),
          element.getAttribute("alt"),
        ].join(" "),
      )
      .join(" ");
  const bothFiles = (node) => {
    const tiles = [
      ...(node?.querySelectorAll('[data-testid="file-thumbnail"]') || []),
    ];
    return [payload.png, payload.txt].every((name) =>
      tiles.some((tile) => metadata(tile).includes(name)),
    );
  };
  const progress = (node) =>
    [
      ...node.querySelectorAll(
        '[role="progressbar"],[aria-busy="true"],[data-cds="Spinner"]',
      ),
    ].some(visible);
  const errorVisible = () =>
    [...document.querySelectorAll('[role="alert"]')].some(
      (node) => visible(node) && node.innerText.trim(),
    );
  const onEdit = (event) => {
    if (
      !ownEdit &&
      event.isTrusted &&
      event.target.closest?.('[data-testid="chat-input"]')
    )
      userEdited = true;
  };
  const events = ["beforeinput", "input", "paste", "drop", "compositionstart"];
  // Prepared means the site accepted both attachments and our prompt as a draft the user
  // can review and submit: file tiles rendered, no upload progress, composer text intact,
  // no error banner, and the site's own send control usable.
  const isPrepared = () => {
    const container = root();
    const composer = editor();
    const send = container?.querySelector('[data-testid="chat-input-send"]');
    return (
      !!container &&
      !!composer &&
      normalize(composer.innerText) === normalize(payload.prompt) &&
      bothFiles(container) &&
      !progress(container) &&
      !errorVisible() &&
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
            "The draft changed while preparing attachments. Review this chat.",
          );
        }
        continue;
      }
      mismatchedSince = 0;
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
    const composer = editor();
    const container = root();
    if (!composer || !container)
      throw new Error(
        "Claude’s composer is unavailable. Open this chat and sign in.",
      );
    if (normalize(composer.innerText))
      throw new Error("This chat has an unsent draft. Send or clear it first.");
    if (
      container.querySelector(
        '[data-testid="file-thumbnail"],[data-cds-attachment]',
      )
    )
      throw new Error(
        "This chat already has attachments. Send or remove them first.",
      );
    if (errorVisible())
      throw new Error(
        "Claude is showing an error. Check the chat before retrying.",
      );
    if (document.querySelector('[data-testid="stop-response"]'))
      return {
        prepared: false,
        busy: true,
        needsReview: false,
        error:
          "Generating a response. Nothing was prepared. Wait for it to finish, then click Add again.",
      };
    const inputs = [
      ...document.querySelectorAll(
        'input[data-testid="file-upload"][type="file"]',
      ),
    ];
    if (
      inputs.length !== 1 ||
      !inputs[0].multiple ||
      inputs[0].disabled ||
      inputs[0].accept
    )
      throw new Error(
        "Claude’s upload control has changed. Nothing was prepared.",
      );
    const input = inputs[0];
    if (input.files?.length)
      throw new Error("This chat already has files selected.");
    if (!payload.screenshot.startsWith("data:image/png;base64,"))
      throw new Error("The capture is not a PNG.");
    const bytes = Uint8Array.from(
      atob(payload.screenshot.split(",")[1]),
      (character) => character.charCodeAt(0),
    );
    const files = new DataTransfer();
    files.items.add(new File([bytes], payload.png, { type: "image/png" }));
    files.items.add(
      new File([payload.text || ""], payload.txt, { type: "text/plain" }),
    );
    globalThis.__pageCapturePreparing = payload.deliveryId;
    for (const event of events) document.addEventListener(event, onEdit, true);
    changed = true;
    input.files = files.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
    const current = editor();
    if (
      url() !== payload.expectedUrl ||
      !current ||
      normalize(current.innerText) ||
      userEdited
    )
      throw new Error(
        "The draft changed while attaching files. Check this chat.",
      );
    ownEdit = true;
    current.focus();
    const inserted = document.execCommand("insertText", false, payload.prompt);
    ownEdit = false;
    if (!inserted)
      throw new Error(
        "Could not fill the composer. Review the attached files in this chat.",
      );
    if (await waitUntilPrepared(60000, 1000)) return { prepared: true };
    throw new Error(
      draftChanged
        ? "The draft changed while preparing attachments. Review this chat."
        : "The attachments did not become ready. Review the draft in Claude.",
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
