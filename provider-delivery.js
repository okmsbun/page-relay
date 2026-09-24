/* Route composer preparation only to providers with a verified integration adapter.
   Adapters attach the capture and insert the prompt; they never submit a message. */
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
  return adapter(destination, capture);
}
