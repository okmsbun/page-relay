/* Route sends only to explicitly enabled, verified integration adapters. */
async function deliverToDestination(destination, capture) {
  const adapters = { chatgpt: deliverToChatGPT };
  const adapter = adapters[destination.providerId];
  if (!AIProviders.get(destination.providerId)?.sending || !adapter) {
    const error = new Error("Sending has not been verified for this provider.");
    error.unsupported = true;
    throw error;
  }
  return adapter(destination, capture);
}
