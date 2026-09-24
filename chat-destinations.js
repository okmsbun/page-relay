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
      const discoveryOnly = provider.sending ? null : provider.limitation;
      return {
        id: tab.id, windowId: tab.windowId, url: identity(tab.url), incognito: !!tab.incognito,
        providerId: provider.id, providerName: provider.name, conversation,
        // Use Chrome's known favicon, never a third-party favicon lookup service.
        favicon: safeFavicon(tab.favIconUrl, provider),
        discoveryOnly,
        title: tab.title?.trim() || "New chat",
        label: [tab.incognito ? "Incognito" : null,
          tab.windowId === currentWindowId ? "This window" : `Other window ${otherWindows.indexOf(tab.windowId) + 1}`,
          `Tab ${tab.index + 1}`, tab.active ? "Active" : "Background"].filter(Boolean).join(" · "),
        unavailable: tab.discarded || tab.frozen ? "Open this tab to load it, then refresh." :
          tab.pendingUrl || tab.status === "loading" ? "This tab is loading. Refresh when ready." : discoveryOnly,
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

  function safeFavicon(rawUrl, provider) {
    try {
      const url = new URL(rawUrl);
      return url.protocol === "https:" && provider.hosts.includes(url.hostname) && !url.username && !url.password
        ? url.href : null;
    } catch { return null; }
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
    const notices = new Map();
    for (const tab of tabs) {
      if (tab.incognito && !incognitoAllowed) continue;
      const provider = AIProviders.landing(tab.url);
      if (provider) notices.set(provider.id, {
        providerId: provider.id, message: `${provider.name} is open on its website, not in a chat.`,
        label: `Open ${provider.name} chat`, url: provider.chatUrl,
      });
    }
    return { destinations: describeTabs(tabs, window.id, incognitoAllowed), notices: [...notices.values()] };
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
          const error = new Error(AIProviders.get(destination.providerId)?.limitation || "No sending adapter is available for this provider.");
          error.unavailable = true;
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
        result = { state: error.needsReview ? "review" : error.unsupported ? "unsupported" : error.unavailable ? "unavailable" : "failed",
          message: error.message || "Could not send to this chat." };
      }
      results.push({ id: destination.id, ...result });
      update(destination.id, result);
    }
    return results;
  }
  return { identity, describeTabs, discover, discoverOverview, validate, sendSelected };
})();
