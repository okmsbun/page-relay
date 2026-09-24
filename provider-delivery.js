/* Route sends only to explicitly enabled, verified integration adapters. */
async function deliverToDestination(destination, capture) {
  const adapters = { chatgpt: deliverToChatGPT };
  const adapter = adapters[destination.providerId];
  if (!AIProviders.get(destination.providerId)?.sending || !adapter) {
    const error = new Error(AIProviders.get(destination.providerId)?.limitation || "No sending adapter is available for this provider.");
    error.unavailable = true;
    throw error;
  }
  return adapter(destination, capture);
}
