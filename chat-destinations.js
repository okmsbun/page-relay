/* Discovery uses Chrome metadata only. No page DOM or private provider APIs. */
const ChatDestinations = (() => {
  function identity(rawUrl) {
    return AIProviders.match(rawUrl)?.url || null;
  }

  function describeTabs(tabs, currentWindowId, incognitoAllowed) {
    const eligible = tabs.filter((tab) => Number.isInteger(tab.id) && identity(tab.url) &&
      (!tab.incognito || incognitoAllowed));
    const windowIds = [...new Set(eligible.map((tab) => tab.windowId))].sort((a, b) => a - b);
    const otherWindows = windowIds.filter((id) => id !== currentWindowId);
    const described = eligible.sort((a, b) => Number(!!a.incognito) - Number(!!b.incognito) ||
      Number(b.windowId === currentWindowId) - Number(a.windowId === currentWindowId) ||
      a.windowId - b.windowId || a.index - b.index).map((tab) => {
      const { provider, conversation } = AIProviders.match(tab.url);
      const unsupported = provider.sending ? null : "Sending has not been verified for this provider.";
      return {
        id: tab.id, windowId: tab.windowId, url: identity(tab.url), incognito: !!tab.incognito,
        providerId: provider.id, providerName: provider.name, conversation,
        unsupported,
        title: tab.title?.trim() || "New chat",
        label: [tab.incognito ? "Incognito" : null,
          tab.windowId === currentWindowId ? "This window" : `Other window ${otherWindows.indexOf(tab.windowId) + 1}`,
          `Tab ${tab.index + 1}`, tab.active ? "Active" : "Background"].filter(Boolean).join(" · "),
        unavailable: tab.discarded || tab.frozen ? "Open this tab to load it, then refresh." :
          tab.pendingUrl || tab.status === "loading" ? "This tab is loading. Refresh when ready." : unsupported,
      };
    });
    const conversations = new Map();
    return described.filter((item) => {
      if (!item.conversation) return true;
      const key = `${item.incognito}:${item.url}`;
      const existing = conversations.get(key);
      if (!existing) { conversations.set(key, item); return true; }
      existing.copies = (existing.copies || 1) + 1;
      return false;
    }).map((item) => ({ ...item, label: item.label + (item.copies ? ` · Open in ${item.copies} tabs` : "") }));
  }

  async function discover() {
    const [tabs, window, incognitoAllowed] = await Promise.all([
      chrome.tabs.query({ url: AIProviders.patterns }),
      chrome.windows.getCurrent(),
      chrome.extension.isAllowedIncognitoAccess(),
    ]);
    return describeTabs(tabs, window.id, incognitoAllowed);
  }

  async function validate(destination) {
    const tab = await chrome.tabs.get(destination.id);
    if (AIProviders.match(tab.url)?.provider.id !== destination.providerId ||
        identity(tab.url) !== destination.url || !!tab.incognito !== destination.incognito ||
        tab.pendingUrl || tab.status === "loading") {
      throw new Error("This tab changed. Refresh and select it again.");
    }
    if (tab.incognito && !await chrome.extension.isAllowedIncognitoAccess()) {
      throw new Error("Incognito access is unavailable.");
    }
    if (tab.discarded || tab.frozen) throw new Error("Open this tab to load it, then retry.");
    return tab;
  }

  // The caller must supply an approved delivery implementation. A resolved
  // promise alone is never treated as proof that the message was sent.
  async function sendSelected(destinations, capture, deliver, update) {
    const results = [];
    for (const destination of destinations) {
      update(destination.id, { state: "sending", message: "Sending…" });
      let result;
      try {
        if (!AIProviders.get(destination.providerId)?.sending) {
          const error = new Error("Sending has not been verified for this provider.");
          error.unsupported = true;
          throw error;
        }
        await validate(destination);
        const receipt = await deliver(destination, capture);
        if (receipt?.sent !== true) {
          const error = new Error("Delivery was not confirmed. Check this chat before retrying.");
          error.needsReview = true;
          throw error;
        }
        result = { state: "sent", message: "Sent" };
      } catch (error) {
        result = { state: error.needsReview ? "review" : error.unsupported ? "unsupported" : "failed",
          message: error.message || "Could not send to this chat." };
      }
      results.push({ id: destination.id, ...result });
      update(destination.id, result);
    }
    return results;
  }
  return { identity, describeTabs, discover, validate, sendSelected };
})();
