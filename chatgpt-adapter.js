/* Isolated, opt-in UI integration. No cookies, private endpoints or API keys.
   ChatGPT can change its DOM; unsupported states fail without a blind submission. */
async function deliverToChatGPT(destination, capture) {
  const deliveryId = crypto.randomUUID();
  const png = `page-${deliveryId}.png`;
  const txt = `page-${deliveryId}.txt`;
  const prompt = `Captured page context [${deliveryId}]\n${capture.title || "Untitled page"}\n${capture.url || ""}\nSee the attached full-page screenshot and extracted page text.${capture.truncated ? " The extracted text reached the capture size limit." : ""}`;
  // Revalidate immediately before injection; the script also checks location.
  await ChatDestinations.validate(destination);
  let results;
  try { results = await chrome.scripting.executeScript({
    target: { tabId: destination.id },
    func: submitCaptureToComposer,
    args: [{ expectedUrl: destination.url, screenshot: capture.screenshot,
      text: capture.text, prompt, png, txt, deliveryId }],
  }); } catch (error) {
    // The tab may have closed after submitting. Do not offer an automatic retry.
    error.needsReview = true;
    throw error;
  }
  const result = results[0]?.result;
  if (!result?.sent) {
    const error = new Error(result?.error || "Delivery could not be confirmed. Check this chat before retrying.");
    error.needsReview = result?.needsReview ?? true;
    throw error;
  }
  return result;
}

async function submitCaptureToComposer(payload) {
  let changed = false;
  let submitted = false;
  let attachmentsReady = false;
  let ownEdit = false;
  let userEdited = false;
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const visible = (element) => element && element.getClientRects().length > 0 &&
    getComputedStyle(element).visibility !== "hidden";
  const currentUrl = () => `${location.origin}${location.pathname.replace(/\/+$/, "") || "/"}${location.search}`;
  const assertLocation = () => {
    if (currentUrl() !== payload.expectedUrl) throw new Error("The conversation changed. Refresh and select it again.");
  };
  const enabled = (element) => visible(element) && !element.disabled && element.getAttribute("aria-disabled") !== "true";
  // Rich-text editors rewrite paragraph breaks, NBSPs and invisible caret marks.
  // Normalize presentation only; never ignore missing/added words or punctuation.
  const normalize = (text) => text.replace(/[\u200B\uFEFF]/g, "").replace(/\s+/g, " ").trim();
  const composerText = (element) => normalize(element.value ?? element.innerText ?? "");
  const expectedText = normalize(payload.prompt);
  const getComposer = () => {
    const matches = [...document.querySelectorAll("#prompt-textarea")].filter(visible);
    return matches.length === 1 ? matches[0] : null;
  };
  const metadata = (root) => [...root.querySelectorAll("[title], [aria-label], img[alt]")]
    .map((element) => [element.getAttribute("title"), element.getAttribute("aria-label"), element.getAttribute("alt")].join(" ")).join(" ") + root.innerText;
  const hasBothFiles = (root) => {
    const text = metadata(root);
    return text.includes(payload.png) && text.includes(payload.txt);
  };
  const observeUserEdit = (event) => {
    if (!ownEdit && event.isTrusted && event.target.closest?.("#prompt-textarea")) userEdited = true;
  };
  const editEvents = ["beforeinput", "input", "paste", "drop", "compositionstart"];
  // A matching outgoing turn is stronger evidence than the state of a composer
  // that may have been reset, replaced, or moved to a new conversation URL.
  const receipt = () => {
    const messages = [...document.querySelectorAll('[data-message-author-role="user"]')];
    const message = messages.find((node) => normalize(node.innerText).includes(expectedText) &&
      node.innerText.includes(`[${payload.deliveryId}]`));
    if (!message) return null;
    const turn = message.closest('[data-testid^="conversation-turn-"]') || message;
    return { sent: (submitted && attachmentsReady) || hasBothFiles(turn) };
  };
  const checkReceipt = async () => {
    const found = receipt();
    if (found?.sent) return found;
    if (found) {
      // The text and file thumbnails need not mount in the same render.
      const complete = await waitForReceipt(2000);
      if (complete) return complete;
      throw new Error("Message found, but both attachments could not be verified. Check this chat before sending again.");
    }
    return null;
  };
  const waitForReceipt = async (duration) => {
    const deadline = Date.now() + duration;
    do {
      const found = receipt();
      if (found?.sent) return found;
      await wait(250);
    } while (Date.now() < deadline);
    return null;
  };
  try {
    assertLocation();
    if (globalThis.__pageCaptureSending) throw new Error("A capture is already being sent to this tab.");
    let composer = getComposer();
    let form = composer?.closest("form");
    if (!visible(composer) || !form) throw new Error("ChatGPT’s message composer is unavailable. Open this chat and sign in, then retry.");
    if (document.querySelector('[data-testid="stop-button"]')) throw new Error("This chat is generating a response. Wait and retry.");
    if (composerText(composer)) throw new Error("This chat has an unsent draft. Send or clear it first.");
    const removeButtons = () => [...form.querySelectorAll('button[aria-label]')].filter((button) =>
      /remove.*(file|attachment|image)|(file|attachment|image).*remove/i.test(button.getAttribute("aria-label")));
    if (removeButtons().length || form.querySelector('[data-testid*="attachment"], [data-testid*="file-thumbnail"]')) {
      throw new Error("This chat already has attachments. Send or remove them first.");
    }
    const accepts = (input, extension, mime) => {
      const accepted = input.accept.toLowerCase().split(",").map((value) => value.trim());
      return !input.accept || accepted.some((value) => value === "*" || value === "*/*" || value === extension ||
        value === mime || value === mime.split("/")[0] + "/*");
    };
    const input = [...document.querySelectorAll('input[type="file"]')].find((element) =>
      element.multiple && !element.disabled && accepts(element, ".png", "image/png") && accepts(element, ".txt", "text/plain"));
    if (!input) throw new Error("ChatGPT’s file upload control is unavailable or has changed. No message was sent.");
    if (input.files?.length) throw new Error("This chat already has files selected. Send or remove them first.");
    if (!payload.screenshot.startsWith("data:image/png;base64,")) throw new Error("The captured screenshot is not a PNG.");
    const binary = atob(payload.screenshot.split(",")[1]);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const files = new DataTransfer();
    files.items.add(new File([bytes], payload.png, { type: "image/png" }));
    files.items.add(new File([payload.text || ""], payload.txt, { type: "text/plain" }));
    globalThis.__pageCaptureSending = payload.deliveryId;
    for (const name of editEvents) document.addEventListener(name, observeUserEdit, true);
    // Everything above is read-only. From here on, leave uncertain drafts intact.
    changed = true;
    input.files = files.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
    assertLocation();
    // Upload may synchronously replace the editor. Never write into a stale node
    // or overwrite text that appeared while attaching the files.
    composer = getComposer();
    if (!composer || composerText(composer) || userEdited) throw new Error("The draft changed while attaching files. Check this chat.");
    ownEdit = true;
    composer.focus();
    if (composer instanceof HTMLTextAreaElement) {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(composer, payload.prompt);
      composer.dispatchEvent(new Event("input", { bubbles: true }));
    } else {
      if (!document.execCommand("insertText", false, payload.prompt)) {
        throw new Error("Could not fill the message composer. Check the attached files in this chat.");
      }
    }
    ownEdit = false;
    const deadline = Date.now() + 60000;
    let readySince = 0;
    while (Date.now() < deadline) {
      await wait(250);
      const accepted = await checkReceipt();
      if (accepted) return accepted;
      composer = getComposer();
      form = composer?.closest("form");
      if (userEdited || !form || currentUrl() !== payload.expectedUrl || composerText(composer) !== expectedText) {
        // The app can clear/re-render its draft before the outgoing turn appears.
        // Only wait for proof; do not refill the composer or click Send again.
        const accepted = await waitForReceipt(2000);
        if (accepted) return accepted;
        throw new Error("The draft changed while preparing attachments. Review this chat.");
      }
      // File names must be present in rendered attachment metadata, not just our
      // assigned FileList. Require both attachments and no visible upload progress.
      const ready = hasBothFiles(form) &&
        ![...form.querySelectorAll('[role="progressbar"], [aria-busy="true"]')].some(visible);
      const send = form.querySelector('[data-testid="send-button"]');
      if (ready && enabled(send)) {
        readySince ||= Date.now();
        if (Date.now() - readySince >= 1000) {
          // The only submission; never retry this click automatically.
          attachmentsReady = true;
          submitted = true;
          send.click();
          const accepted = await waitForReceipt(15000);
          if (accepted) return accepted;
          throw new Error("Submission was attempted but not confirmed. Check this chat before sending again.");
        }
      } else readySince = 0;
    }
    throw new Error("Attachments did not become ready. Check this chat’s draft and upload status.");
  } catch (error) {
    return { sent: false, needsReview: changed || submitted, error: error.message };
  } finally {
    for (const name of editEvents) document.removeEventListener(name, observeUserEdit, true);
    if (globalThis.__pageCaptureSending === payload.deliveryId) delete globalThis.__pageCaptureSending;
  }
}
