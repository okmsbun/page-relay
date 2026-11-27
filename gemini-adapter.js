/* Files only. The shared preparation routine preserves the existing composer. */
async function prepareInGemini(destination, capture, options) {
  const payload = CapturePreparation.payload(
    { ...destination, providerId: "gemini" },
    capture,
    options,
  );
  const retryDelays = [150, 250, 400, 600];
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const isTransientTabError = (error) =>
    /tabs cannot be edited right now|cannot be edited right now|dragging a tab/i.test(
      String(error?.message ?? error ?? ""),
    );
  async function retryTabAction(action, label, deadline = payload.deadline) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await action();
      } catch (error) {
        if (
          !isTransientTabError(error) ||
          attempt >= retryDelays.length ||
          Date.now() >= deadline
        ) {
          if (isTransientTabError(error)) {
            const busyError = new Error(
              "Chrome tabs are temporarily busy. Wait a moment, then click Add again.",
            );
            busyError.busy = true;
            busyError.needsReview = false;
            busyError.transientTab = true;
            busyError.diagnostic = {
              reason: "tab-strip-busy",
              operation: label,
              attempts: attempt + 1,
              cause: error.message,
            };
            throw busyError;
          }
          throw error;
        }
        globalThis.console?.warn?.(
          "[Page Relay] Retrying Gemini tab operation after temporary Chrome tab lock:",
          { operation: label, attempt: attempt + 1, cause: error.message },
        );
        await wait(retryDelays[attempt]);
      }
    }
  }

  await ChatDestinations.validate(destination);
  let result;
  const [previous] = await chrome.tabs.query({
    active: true,
    windowId: destination.windowId,
  });
  let activated = false;
  let injectionStarted = false;
  try {
    if (Date.now() >= payload.deadline)
      throw new Error("Preparation expired before upload. Refresh and retry.");
    if (previous?.id !== destination.id) {
      await retryTabAction(
        () => chrome.tabs.update(destination.id, { active: true }),
        "gemini-activate-tab",
      );
      activated = true;
    }
    await ChatDestinations.validate(destination);
    if (Date.now() >= payload.deadline)
      throw new Error("Preparation expired before upload. Refresh and retry.");
    injectionStarted = true;
    const results = await chrome.scripting.executeScript({
      target: { tabId: destination.id },
      func: prepareFilesInComposer,
      args: [payload],
    });
    result = results[0]?.result;
  } catch (error) {
    if (injectionStarted) {
      error.needsReview = true;
      error.busy = false;
    } else if (error.needsReview === undefined) {
      error.needsReview = false;
    }
    throw error;
  } finally {
    if (activated && previous?.id) {
      // Do not override a tab switch the user made while preparing.
      // Restoring focus is best effort: it must not hold a confirmed result open.
      let restoreTimer;
      let restoreExpired = false;
      const restoreDeadline = Date.now() + 2000;
      try {
        await Promise.race([
          new Promise((resolve) => {
            restoreTimer = setTimeout(() => {
              restoreExpired = true;
              resolve();
            }, 2000);
          }),
          (async () => {
            await retryTabAction(
              async () => {
                if (restoreExpired) return;
                const [current] = await chrome.tabs.query({
                  active: true,
                  windowId: destination.windowId,
                });
                if (!restoreExpired && current?.id === destination.id) {
                  await chrome.tabs.update(previous.id, { active: true });
                }
              },
              "gemini-restore-tab",
              restoreDeadline,
            );
          })(),
        ]);
      } catch {
        /* The old tab/window may have closed; preserve the preparation result. */
      } finally {
        restoreExpired = true;
        clearTimeout(restoreTimer);
      }
    }
  }
  if (result?.prepared) return { ...result, prepared: true };
  const error = new Error(
    result?.error || "The capture could not be prepared in this Gemini chat.",
  );
  error.needsReview = result?.needsReview ?? true;
  error.busy = result?.busy === true && result.needsReview === false;
  if (Array.isArray(result?.delivered)) error.delivered = result.delivered;
  if (Array.isArray(result?.failedKinds)) error.failedKinds = result.failedKinds;
  throw error;
}

async function prepareInGeminiComposer(payload) {
  return prepareFilesInComposer({
    ...payload,
    providerId: "gemini",
    deadline: payload.deadline ?? Date.now() + 140000,
  });
}
