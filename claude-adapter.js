/* Claude integration only. Uses the signed-in UI, not private APIs or cookies. */
async function deliverToClaude(destination, capture) {
  await ChatDestinations.validate(destination);
  const deliveryId = crypto.randomUUID();
  const payload = {
    expectedUrl: destination.url, deliveryId,
    screenshot: capture.screenshot, text: capture.text,
    png: `page-${deliveryId}.png`, txt: `page-${deliveryId}.txt`,
    prompt: `Captured page context [${deliveryId}]\n${capture.title || "Untitled page"}\n${capture.url || ""}\nUse the attached screenshot and extracted page text.${capture.truncated ? " The extracted text reached the capture size limit." : ""}`,
  };
  let result;
  try {
    const results = await chrome.scripting.executeScript({ target: { tabId: destination.id }, func: submitToClaude, args: [payload] });
    result = results[0]?.result;
  } catch (error) { error.needsReview = true; throw error; }
  if (result?.sent) return result;
  const error = new Error(result?.error || "Delivery was not confirmed. Check this Claude chat.");
  error.needsReview = result?.needsReview ?? true;
  throw error;
}

async function submitToClaude(payload) {
  let changed = false, submitted = false, ownEdit = false, userEdited = false;
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const normalize = (text) => text.replace(/[\u200B\uFEFF]/g, "").replace(/\s+/g, " ").trim();
  const visible = (node) => node && node.getClientRects().length > 0 && getComputedStyle(node).visibility !== "hidden";
  const url = () => `${location.origin}${location.pathname.replace(/\/+$/, "") || "/"}${location.search}`;
  const editor = () => {
    const nodes = [...document.querySelectorAll('[data-testid="chat-input"][contenteditable="true"]')].filter(visible);
    return nodes.length === 1 ? nodes[0] : null;
  };
  const root = () => editor()?.closest('[data-cds="ChatComposer"]');
  const metadata = (node) => (node?.innerText || "") + [...(node?.querySelectorAll('[title],[aria-label],img[alt]') || [])]
    .map((e) => [e.getAttribute("title"), e.getAttribute("aria-label"), e.getAttribute("alt")].join(" ")).join(" ");
  const bothFiles = (node) => {
    const tiles = [...(node?.querySelectorAll('[data-testid="file-thumbnail"]') || [])];
    return [payload.png, payload.txt].every((name) => tiles.some((tile) => metadata(tile).includes(name)));
  };
  const receipt = () => [...document.querySelectorAll('[data-testid="user-message"]')].find((node) =>
    normalize(node.innerText) === normalize(payload.prompt) && node.innerText.includes(`[${payload.deliveryId}]`) &&
    bothFiles(node.closest('[data-cds="UserMessage"]')));
  const progress = (node) => [...node.querySelectorAll('[role="progressbar"],[aria-busy="true"],[data-cds="Spinner"]')].some(visible);
  const errorVisible = () => [...document.querySelectorAll('[role="alert"]')].some((node) => visible(node) && node.innerText.trim());
  const onEdit = (event) => {
    if (!ownEdit && event.isTrusted && event.target.closest?.('[data-testid="chat-input"]')) userEdited = true;
  };
  const events = ["beforeinput", "input", "paste", "drop", "compositionstart"];
  async function confirm(ms) {
    const end = Date.now() + ms;
    let since = 0;
    while (Date.now() < end) {
      if (receipt() && !errorVisible()) {
        since ||= Date.now();
        if (Date.now() - since >= 1000) return { sent: true };
      } else since = 0;
      await wait(250);
    }
    return null;
  }
  try {
    if (url() !== payload.expectedUrl) throw new Error("This conversation changed. Refresh and select it again.");
    if (globalThis.__pageCaptureSending) throw new Error("A capture is already being sent to this tab.");
    const composer = editor(), container = root();
    if (!composer || !container) throw new Error("Claude’s composer is unavailable. Open this chat and sign in.");
    if (normalize(composer.innerText)) throw new Error("This chat has an unsent draft. Send or clear it first.");
    if (container.querySelector('[data-testid="file-thumbnail"],[data-cds-attachment]')) throw new Error("This chat already has attachments. Send or remove them first.");
    if (document.querySelector('[data-testid="stop-response"]') || errorVisible()) throw new Error("Claude is busy or showing an error. Check the chat before retrying.");
    const inputs = [...document.querySelectorAll('input[data-testid="file-upload"][type="file"]')];
    if (inputs.length !== 1 || !inputs[0].multiple || inputs[0].disabled || inputs[0].accept) throw new Error("Claude’s upload control has changed. Nothing was sent.");
    const input = inputs[0];
    if (input.files?.length) throw new Error("This chat already has files selected.");
    if (!payload.screenshot.startsWith("data:image/png;base64,")) throw new Error("The capture is not a PNG.");
    const bytes = Uint8Array.from(atob(payload.screenshot.split(",")[1]), (c) => c.charCodeAt(0));
    const files = new DataTransfer();
    files.items.add(new File([bytes], payload.png, { type: "image/png" }));
    files.items.add(new File([payload.text || ""], payload.txt, { type: "text/plain" }));
    globalThis.__pageCaptureSending = payload.deliveryId;
    for (const event of events) document.addEventListener(event, onEdit, true);
    changed = true;
    input.files = files.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
    const current = editor();
    if (url() !== payload.expectedUrl || !current || normalize(current.innerText) || userEdited) throw new Error("The draft changed while attaching files. Check this chat.");
    ownEdit = true;
    current.focus();
    const inserted = document.execCommand("insertText", false, payload.prompt);
    ownEdit = false;
    if (!inserted) throw new Error("Could not fill the composer. Review the attached files in this chat.");
    let readySince = 0;
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      await wait(250);
      if (receipt()) { const accepted = await confirm(2500); if (accepted) return accepted; }
      if (userEdited || url() !== payload.expectedUrl || !editor() || normalize(editor().innerText) !== normalize(payload.prompt)) {
        const accepted = await confirm(2500);
        if (accepted) return accepted;
        throw new Error("The draft changed while preparing attachments. Review this chat.");
      }
      if (errorVisible()) throw new Error("Claude reported an error. Review this chat’s draft and attachments.");
      const container = root();
      const send = container?.querySelector('[data-testid="chat-input-send"]');
      const ready = container && bothFiles(container) && !progress(container) && visible(send) && !send.disabled && send.getAttribute("aria-disabled") !== "true";
      if (!ready) { readySince = 0; continue; }
      readySince ||= Date.now();
      if (Date.now() - readySince < 1000) continue;
      submitted = true;
      send.click(); // Exactly one attempt. Never refill or retry an uncertain send.
      const accepted = await confirm(30000);
      if (accepted) return accepted;
      throw new Error("Submission was attempted but both attachments and the message could not be confirmed. Check this chat before retrying.");
    }
    throw new Error("The attachments did not become ready. Review the draft in Claude.");
  } catch (error) {
    return { sent: false, needsReview: changed || submitted, error: error.message };
  } finally {
    for (const event of events) document.removeEventListener(event, onEdit, true);
    if (globalThis.__pageCaptureSending === payload.deliveryId) delete globalThis.__pageCaptureSending;
  }
}
