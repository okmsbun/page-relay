/* Route composer preparation only to providers with a verified integration adapter.
   Adapters attach PNG + metadata TXT without editing or submitting a message. */
async function prepareInDestination(destination, capture) {
  const adapters = {
    chatgpt: prepareInChatGPT,
    claude: prepareInClaude,
    gemini: prepareInGemini,
  };
  const adapter = adapters[destination.providerId];
  if (
    !AIProviders.supported(AIProviders.get(destination.providerId)) ||
    !adapter
  ) {
    const error = new Error(
      "No composer-preparation integration is available for this provider.",
    );
    error.unavailable = true;
    throw error;
  }
  // Web Locks are shared by extension pages, including panels in other windows.
  // Hold them for the real adapter lifetime, not merely the queue's UI timeout.
  async function exclusive(name, action) {
    if (!globalThis.navigator?.locks)
      throw new Error("Preparation coordination is unavailable. Reopen the Side Panel and retry.");
    return navigator.locks.request(`pagerelay:${name}`, { ifAvailable: true }, (lock) => {
      if (!lock) {
        const error = new Error("Another preparation is using this conversation or Gemini window. Wait, then retry.");
        error.busy = true;
        error.needsReview = false;
        throw error;
      }
      return action();
    });
  }
  const conversation = AIProviders.match(destination.url)?.conversation;
  const key = `${!!destination.incognito}:${destination.providerId}:${conversation ? destination.url : destination.id}`;
  return exclusive(`conversation:${key}`, () => destination.providerId === "gemini"
    ? exclusive(`gemini-window:${destination.windowId}`, () => adapter(destination, capture))
    : adapter(destination, capture));
}
