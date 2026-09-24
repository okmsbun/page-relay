/* URL discovery for providers with a complete, verified composer-preparation
   integration. Discovery is read-only: it never changes the capture, a chat, or any
   message, and the extension never submits on the user's behalf. */
const ChatDestinations = (() => {
  function identity(rawUrl) {
    return AIProviders.match(rawUrl)?.url || null;
  }

  function describeTabs(tabs, currentWindowId, incognitoAllowed) {
    const eligible = tabs.filter(
      (tab) =>
        Number.isInteger(tab.id) &&
        AIProviders.supported(AIProviders.match(tab.url)?.provider) &&
        (!tab.incognito || incognitoAllowed),
    );
    const windowIds = [...new Set(eligible.map((tab) => tab.windowId))].sort(
      (a, b) => a - b,
    );
    const otherWindows = windowIds.filter((id) => id !== currentWindowId);
    const described = eligible
      .sort(
        (a, b) =>
          Number(!!a.incognito) - Number(!!b.incognito) ||
          Number(b.windowId === currentWindowId) -
            Number(a.windowId === currentWindowId) ||
          a.windowId - b.windowId ||
          a.index - b.index,
      )
      .map((tab) => {
        const { provider, conversation } = AIProviders.match(tab.url);
        return {
          id: tab.id,
          windowId: tab.windowId,
          url: identity(tab.url),
          incognito: !!tab.incognito,
          providerId: provider.id,
          providerName: provider.name,
          conversation,
          // Use Chrome's known favicon, never a third-party favicon lookup service.
          favicon: safeFavicon(tab.favIconUrl, provider),
          title: tab.title?.trim() || "New chat",
          label: [
            tab.incognito ? "Incognito" : null,
            tab.windowId === currentWindowId
              ? "This window"
              : `Other window ${otherWindows.indexOf(tab.windowId) + 1}`,
            `Tab ${tab.index + 1}`,
            tab.active ? "Active" : "Background",
          ]
            .filter(Boolean)
            .join(" · "),
          unavailable:
            tab.discarded || tab.frozen
              ? "Open this tab to load it, then refresh."
              : tab.pendingUrl || tab.status === "loading"
                ? "This tab is loading. Refresh when ready."
                : null,
        };
      });
    const conversations = new Map();
    return described
      .filter((item) => {
        if (!item.conversation) return true;
        const key = `${item.incognito}:${item.url}`;
        const existing = conversations.get(key);
        if (!existing) {
          conversations.set(key, item);
          return true;
        }
        existing.copies = (existing.copies || 1) + 1;
        return false;
      })
      .map((item) => ({
        ...item,
        label:
          item.label + (item.copies ? ` · Open in ${item.copies} tabs` : ""),
      }));
  }

  function safeFavicon(rawUrl, provider) {
    try {
      const url = new URL(rawUrl);
      return url.protocol === "https:" &&
        provider.hosts.includes(url.hostname) &&
        !url.username &&
        !url.password
        ? url.href
        : null;
    } catch {
      return null;
    }
  }

  async function discover() {
    return (await discoverOverview()).destinations;
  }

  async function discoverOverview() {
    const [tabs, window, incognitoAllowed] = await Promise.all([
      chrome.tabs.query({ url: AIProviders.patterns }),
      chrome.windows.getCurrent(),
      chrome.extension.isAllowedIncognitoAccess(),
    ]);
    return { destinations: describeTabs(tabs, window.id, incognitoAllowed) };
  }

  async function validate(destination) {
    const tab = await chrome.tabs.get(destination.id);
    if (
      !AIProviders.supported(AIProviders.get(destination.providerId)) ||
      AIProviders.match(tab.url)?.provider.id !== destination.providerId ||
      identity(tab.url) !== destination.url ||
      !!tab.incognito !== destination.incognito ||
      tab.pendingUrl ||
      tab.status === "loading"
    ) {
      throw new Error("This tab changed. Refresh and select it again.");
    }
    if (tab.incognito && !(await chrome.extension.isAllowedIncognitoAccess())) {
      throw new Error("Incognito access is unavailable.");
    }
    if (tab.discarded || tab.frozen)
      throw new Error("Open this tab to load it, then retry.");
    return tab;
  }

  // The caller must supply an approved preparation implementation. A resolved
  // promise alone is never treated as proof that the composer holds the capture.
  async function prepareSelected(destinations, capture, prepare, update) {
    const results = [];
    for (const destination of destinations) {
      update(destination.id, { state: "preparing", message: "Adding…" });
      let result;
      try {
        if (!AIProviders.supported(AIProviders.get(destination.providerId))) {
          const error = new Error(
            "No composer-preparation integration is available for this provider.",
          );
          error.unavailable = true;
          throw error;
        }
        await validate(destination);
        const prepared = await prepare(destination, capture);
        if (prepared?.prepared !== true) {
          const error = new Error(
            "The capture was not confirmed in this chat. Check it before retrying.",
          );
          error.needsReview = true;
          throw error;
        }
        result = { state: "prepared", message: "Added to chat" };
      } catch (error) {
        // Only an explicit pre-mutation busy result is safe to retry. Never
        // infer retry safety from error text or downgrade an uncertain preparation.
        result = {
          state: error.needsReview
            ? "review"
            : error.busy === true && error.needsReview === false
              ? "busy"
              : error.unsupported
                ? "unsupported"
                : error.unavailable
                  ? "unavailable"
                  : "failed",
          message: error.message || "Could not add the capture to this chat.",
        };
      }
      results.push({ id: destination.id, ...result });
      update(destination.id, result);
    }
    return results;
  }
  return {
    identity,
    describeTabs,
    discover,
    discoverOverview,
    validate,
    prepareSelected,
  };
})();
