/* Files only. The shared preparation routine preserves the existing composer. */
async function prepareInClaude(destination, capture) {
  const payload = CapturePreparation.payload({ ...destination, providerId: "claude" }, capture);
  await ChatDestinations.validate(destination);
  if (Date.now() >= payload.deadline) throw new Error("Preparation expired before upload. Refresh and retry.");
  let result;
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: destination.id },
      func: prepareFilesInComposer,
      args: [payload],
    });
    result = results[0]?.result;
  } catch (error) {
    error.needsReview = true;
    throw error;
  }
  if (result?.prepared) return { ...result, prepared: true };
  const error = new Error(
    result?.error || "The capture could not be prepared in this Claude chat.",
  );
  error.needsReview = result?.needsReview ?? true;
  error.busy = result?.busy === true && result.needsReview === false;
  throw error;
}

async function prepareInClaudeComposer(payload) {
  return prepareFilesInComposer({ ...payload, providerId: "claude", deadline: payload.deadline ?? Date.now() + 140000 });
}
