/* Files only. The shared preparation routine preserves the existing composer. */
async function prepareInChatGPT(destination, capture) {
  const payload = CapturePreparation.payload({ ...destination, providerId: "chatgpt" }, capture);
  // Revalidate immediately before injection; the script also checks location.
  await ChatDestinations.validate(destination);
  if (Date.now() >= payload.deadline) throw new Error("Preparation expired before upload. Refresh and retry.");
  let results;
  try {
    results = await chrome.scripting.executeScript({
      target: { tabId: destination.id },
      func: prepareFilesInComposer,
      args: [payload],
    });
  } catch (error) {
    // The tab may have closed after the composer was changed. Do not retry blindly.
    error.needsReview = true;
    throw error;
  }
  const result = results[0]?.result;
  if (result?.prepared) return { ...result, prepared: true };
  const error = new Error(
    result?.error || "The capture could not be prepared in this chat.",
  );
  error.needsReview = result?.needsReview ?? true;
  error.busy = result?.busy === true && result.needsReview === false;
  throw error;
}

async function prepareCaptureInComposer(payload) {
  return prepareFilesInComposer({ ...payload, providerId: "chatgpt", deadline: payload.deadline ?? Date.now() + 140000 });
}
