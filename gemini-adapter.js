/* Files only. The shared preparation routine preserves the existing composer. */
async function prepareInGemini(destination, capture) {
  const payload = CapturePreparation.payload({ ...destination, providerId: "gemini" }, capture);
  await ChatDestinations.validate(destination);
  let result;
  const [previous] = await chrome.tabs.query({
    active: true,
    windowId: destination.windowId,
  });
  let activated = false;
  let injectionStarted = false;
  try {
    if (Date.now() >= payload.deadline) throw new Error("Preparation expired before upload. Refresh and retry.");
    if (previous?.id !== destination.id) {
      await chrome.tabs.update(destination.id, { active: true });
      activated = true;
    }
    await ChatDestinations.validate(destination);
    if (Date.now() >= payload.deadline) throw new Error("Preparation expired before upload. Refresh and retry.");
    injectionStarted = true;
    const results = await chrome.scripting.executeScript({
      target: { tabId: destination.id },
      func: prepareFilesInComposer,
      args: [payload],
    });
    result = results[0]?.result;
  } catch (error) {
    error.needsReview = injectionStarted;
    throw error;
  } finally {
    if (activated && previous?.id) {
      // Do not override a tab switch the user made while preparing.
      // Restoring focus is best effort: it must not hold a confirmed result open.
      let restoreTimer;
      let restoreExpired = false;
      try {
        await Promise.race([
          new Promise((resolve) => {
            restoreTimer = setTimeout(() => { restoreExpired = true; resolve(); }, 2000);
          }),
          (async () => {
            const [current] = await chrome.tabs.query({
              active: true,
              windowId: destination.windowId,
            });
            if (!restoreExpired && current?.id === destination.id)
              await chrome.tabs.update(previous.id, { active: true });
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
  throw error;
}

async function prepareInGeminiComposer(payload) {
  return prepareFilesInComposer({ ...payload, providerId: "gemini", deadline: payload.deadline ?? Date.now() + 140000 });
}
