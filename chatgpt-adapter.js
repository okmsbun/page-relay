/* Isolated, opt-in UI integration. No cookies, private endpoints or API keys.
   Preparation only: the screenshot, extracted text and prompt are placed in the composer
   and the user submits. This extension never submits, presses Enter, or starts generation.
   ChatGPT can change its DOM; unsupported states fail without mutating the chat. */
async function prepareInChatGPT(destination, capture) {
  const deliveryId = crypto.randomUUID();
  const png = `page-${deliveryId}.png`;
  const txt = `page-${deliveryId}.txt`;
  const prompt = `Captured page context [${deliveryId}]\n${capture.title || "Untitled page"}\n${capture.url || ""}\nSee the attached full-page screenshot and extracted page text.${capture.truncated ? " The extracted text reached the capture size limit." : ""}`;
  // Revalidate immediately before injection; the script also checks location.
  await ChatDestinations.validate(destination);
  let results;
  try {
    results = await chrome.scripting.executeScript({
      target: { tabId: destination.id },
      func: prepareCaptureInComposer,
      args: [
        {
          expectedUrl: destination.url,
          screenshot: capture.screenshot,
          text: capture.text,
          prompt,
          png,
          txt,
          deliveryId,
        },
      ],
    });
  } catch (error) {
    // The tab may have closed after the composer was changed. Do not retry blindly.
    error.needsReview = true;
    throw error;
  }
  const result = results[0]?.result;
  if (result?.prepared) return result;
  const error = new Error(
    result?.error || "The capture could not be prepared in this chat.",
  );
  error.needsReview = result?.needsReview ?? true;
  error.busy = result?.busy === true && result.needsReview === false;
  throw error;
}

async function prepareCaptureInComposer(payload) {
  let changed = false;
  let ownEdit = false;
  let userEdited = false;
  let draftChanged = false;
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const visible = (element) =>
    element &&
    element.getClientRects().length > 0 &&
    getComputedStyle(element).visibility !== "hidden";
  const currentUrl = () =>
    `${location.origin}${location.pathname.replace(/\/+$/, "") || "/"}${location.search}`;
  const assertLocation = () => {
    if (currentUrl() !== payload.expectedUrl)
      throw new Error("The conversation changed. Refresh and select it again.");
  };
  const enabled = (element) =>
    visible(element) &&
    !element.disabled &&
    element.getAttribute("aria-disabled") !== "true";
  // Rich-text editors rewrite paragraph breaks, NBSPs and invisible caret marks.
  // Normalize presentation only; never ignore missing/added words or punctuation.
  const normalize = (text) =>
    text
      .replace(/[\u200B\uFEFF]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  const composerText = (element) =>
    normalize(element.value ?? element.innerText ?? "");
  const expectedText = normalize(payload.prompt);
  const getComposer = () => {
    const matches = [...document.querySelectorAll("#prompt-textarea")].filter(
      visible,
    );
    return matches.length === 1 ? matches[0] : null;
  };
  const metadata = (root) =>
    [...root.querySelectorAll("[title], [aria-label], img[alt]")]
      .map((element) =>
        [
          element.getAttribute("title"),
          element.getAttribute("aria-label"),
          element.getAttribute("alt"),
        ].join(" "),
      )
      .join(" ") + root.innerText;
  const hasBothFiles = (root) => {
    const text = metadata(root);
    return text.includes(payload.png) && text.includes(payload.txt);
  };
  const visibleProgress = (root) =>
    [...root.querySelectorAll('[role="progressbar"], [aria-busy="true"]')].some(
      visible,
    );
  const observeUserEdit = (event) => {
    if (
      !ownEdit &&
      event.isTrusted &&
      event.target.closest?.("#prompt-textarea")
    )
      userEdited = true;
  };
  const editEvents = [
    "beforeinput",
    "input",
    "paste",
    "drop",
    "compositionstart",
  ];
  // Prepared means the site accepted both attachments and our prompt as a draft the user
  // can review and submit: the file names are rendered, no upload is in progress, the
  // composer still holds exactly our prompt, and the site's send control is usable.
  const isPrepared = (form, composer) =>
    hasBothFiles(form) &&
    !visibleProgress(form) &&
    composerText(composer) === expectedText &&
    enabled(form.querySelector('[data-testid="send-button"]'));
  // Waits for a prepared composer that stays prepared. A brief re-render of the draft is
  // tolerated; a draft that stops holding our prompt is reported for review immediately.
  // Nothing here ever submits.
  async function waitUntilPrepared(duration, stableFor) {
    const deadline = Date.now() + duration;
    let since = 0;
    let mismatchedSince = 0;
    while (Date.now() < deadline) {
      await wait(250);
      const composer = getComposer();
      const form = composer?.closest("form");
      const mismatch =
        !form ||
        currentUrl() !== payload.expectedUrl ||
        composerText(composer) !== expectedText;
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
      if (isPrepared(form, composer)) {
        since ||= Date.now();
        if (Date.now() - since >= stableFor) return true;
      } else since = 0;
    }
    return false;
  }
  try {
    assertLocation();
    if (globalThis.__pageCapturePreparing)
      throw new Error("A capture is already being prepared in this tab.");
    let composer = getComposer();
    const form = composer?.closest("form");
    if (!visible(composer) || !form)
      throw new Error(
        "ChatGPT’s message composer is unavailable. Open this chat and sign in, then retry.",
      );
    // Busy is retryable only here, before attaching or editing anything.
    if (document.querySelector('[data-testid="stop-button"]'))
      return {
        prepared: false,
        busy: true,
        needsReview: false,
        error:
          "Generating a response. Nothing was prepared. Wait for it to finish, then click Add again.",
      };
    if (composerText(composer))
      throw new Error("This chat has an unsent draft. Send or clear it first.");
    const removeButtons = () =>
      [...form.querySelectorAll("button[aria-label]")].filter((button) =>
        /remove.*(file|attachment|image)|(file|attachment|image).*remove/i.test(
          button.getAttribute("aria-label"),
        ),
      );
    if (
      removeButtons().length ||
      form.querySelector(
        '[data-testid*="attachment"], [data-testid*="file-thumbnail"]',
      )
    ) {
      throw new Error(
        "This chat already has attachments. Send or remove them first.",
      );
    }
    const accepts = (input, extension, mime) => {
      const accepted = input.accept
        .toLowerCase()
        .split(",")
        .map((value) => value.trim());
      return (
        !input.accept ||
        accepted.some(
          (value) =>
            value === "*" ||
            value === "*/*" ||
            value === extension ||
            value === mime ||
            value === mime.split("/")[0] + "/*",
        )
      );
    };
    const input = [...document.querySelectorAll('input[type="file"]')].find(
      (element) =>
        element.multiple &&
        !element.disabled &&
        accepts(element, ".png", "image/png") &&
        accepts(element, ".txt", "text/plain"),
    );
    if (!input)
      throw new Error(
        "ChatGPT’s file upload control is unavailable or has changed. Nothing was prepared.",
      );
    if (input.files?.length)
      throw new Error(
        "This chat already has files selected. Send or remove them first.",
      );
    if (!payload.screenshot.startsWith("data:image/png;base64,"))
      throw new Error("The captured screenshot is not a PNG.");
    const binary = atob(payload.screenshot.split(",")[1]);
    const bytes = Uint8Array.from(binary, (character) =>
      character.charCodeAt(0),
    );
    const files = new DataTransfer();
    files.items.add(new File([bytes], payload.png, { type: "image/png" }));
    files.items.add(
      new File([payload.text || ""], payload.txt, { type: "text/plain" }),
    );
    globalThis.__pageCapturePreparing = payload.deliveryId;
    for (const name of editEvents)
      document.addEventListener(name, observeUserEdit, true);
    // Everything above is read-only. From here on, leave uncertain drafts intact.
    changed = true;
    input.files = files.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
    assertLocation();
    // Upload may synchronously replace the editor. Never write into a stale node
    // or overwrite text that appeared while attaching the files.
    composer = getComposer();
    if (!composer || composerText(composer) || userEdited)
      throw new Error(
        "The draft changed while attaching files. Check this chat.",
      );
    ownEdit = true;
    composer.focus();
    if (composer instanceof HTMLTextAreaElement) {
      Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      ).set.call(composer, payload.prompt);
      composer.dispatchEvent(new Event("input", { bubbles: true }));
    } else {
      if (!document.execCommand("insertText", false, payload.prompt)) {
        throw new Error(
          "Could not fill the message composer. Check the attached files in this chat.",
        );
      }
    }
    ownEdit = false;
    if (await waitUntilPrepared(60000, 1000)) return { prepared: true };
    throw new Error(
      draftChanged
        ? "The draft changed while preparing attachments. Review this chat."
        : "The attachments did not become ready. Check this chat’s draft and upload status.",
    );
  } catch (error) {
    return { prepared: false, needsReview: changed, error: error.message };
  } finally {
    for (const name of editEvents)
      document.removeEventListener(name, observeUserEdit, true);
    if (globalThis.__pageCapturePreparing === payload.deliveryId)
      delete globalThis.__pageCapturePreparing;
  }
}
