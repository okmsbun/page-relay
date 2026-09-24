/* Integration-only registry. A recognized URL is NOT proof of send capability.
   Enable a sender only after checking its signed-in composer, both attachments,
   draft protection, and outgoing-turn confirmation. See INTEGRATIONS.md. */
const AIProviders = (() => {
  const providers = [
    { id: "chatgpt", name: "ChatGPT", hosts: ["chatgpt.com", "chat.openai.com"],
      route: /^(?:\/(?:c\/[^/]+|g\/[^/]+(?:\/c\/[^/]+)?)?)$/, conversation: /\/c\/[^/]+$/,
      sending: true },
    { id: "claude", name: "Claude", hosts: ["claude.ai"],
      sending: true,
      route: /^\/(?:new|chat\/[^/]+)?$/, conversation: /^\/chat\/[^/]+$/ },
    { id: "gemini", name: "Gemini", hosts: ["gemini.google.com"],
      sending: true,
      route: /^\/(?:u\/\d+\/)?app(?:\/[^/]+)?$/, conversation: /\/app\/[^/]+$/ },
    { id: "deepseek", name: "DeepSeek", hosts: ["chat.deepseek.com"],
      landingHosts: ["www.deepseek.com", "deepseek.com"], chatUrl: "https://chat.deepseek.com/",
      limitation: "DeepSeek sending is not implemented. Its composer and file control were inspected, but screenshot/text acceptance, draft protection, and delivery confirmation remain unverified.",
      route: /^\/(?:a\/chat\/s\/[^/]+)?$/, conversation: /^\/a\/chat\/s\/[^/]+$/ },
    { id: "perplexity", name: "Perplexity", hosts: ["perplexity.ai", "www.perplexity.ai"],
      limitation: "Perplexity sending is not implemented. Its composer and file control were inspected; combined uploads, draft protection, and delivery confirmation remain unverified.",
      route: /^\/(?:search\/[^/]+)?$/, conversation: /^\/search\/[^/]+$/ },
    { id: "copilot", name: "Microsoft Copilot", hosts: ["copilot.microsoft.com"],
      limitation: "Copilot sending is not implemented. Live verification reached account authorization consent; uploads, draft protection, and delivery confirmation remain unverified.",
      route: /^\/(?:chats\/[^/]+)?$/, conversation: /^\/chats\/[^/]+$/ },
    { id: "grok", name: "Grok", hosts: ["grok.com"],
      limitation: "Grok sending is not implemented. Its guest composer requires agreement to terms before messaging; both-file readiness, draft protection, and delivery remain unverified.",
      route: /^\/(?:(?:c|chat)\/[^/]+)?$/, conversation: /^\/(?:c|chat)\/[^/]+$/ },
    { id: "meta", name: "Meta AI", hosts: ["www.meta.ai", "meta.ai"],
      limitation: "Meta AI sending is not implemented. Live verification redirected to authentication; a signed-in composer and the complete sending flow remain unverified.",
      route: /^\/(?:new|c\/[^/]+)?$/, conversation: /^\/c\/[^/]+$/ },
    { id: "mistral", name: "Mistral Vibe Chat", hosts: ["chat.mistral.ai"],
      limitation: "Vibe Chat sending is not implemented. Live verification required sign-in; upload readiness, draft preservation, and delivery confirmation remain unverified.",
      route: /^\/(?:chat(?:\/[^/]+)?)?$/, conversation: /^\/chat\/[^/]+$/ },
    { id: "poe", name: "Poe", hosts: ["poe.com", "www.poe.com"],
      limitation: "Poe sending is not implemented. Its composer and file control were inspected; per-bot image/file acceptance, draft protection, and delivery remain unverified.",
      route: /^\/(?:chat\/[^/]+)?$/, conversation: /^\/chat\/[^/]+$/ },
  ];
  function match(rawUrl) {
    try {
      const url = new URL(rawUrl);
      if (url.protocol !== "https:" || url.port || url.username || url.password) return null;
      const path = url.pathname.replace(/\/+$/, "") || "/";
      const provider = providers.find((item) => item.hosts.includes(url.hostname) && item.route.test(path));
      if (!provider) return null;
      const identity = `${url.origin}${path}${url.search}`;
      return { provider, url: identity, conversation: provider.conversation.test(path) };
    } catch { return null; }
  }
  return {
    all: providers,
    patterns: providers.flatMap((provider) => [...provider.hosts, ...(provider.landingHosts || [])].map((host) => `https://${host}/*`)),
    landing(rawUrl) {
      try {
        const url = new URL(rawUrl);
        if (url.protocol !== "https:" || url.port || url.username || url.password) return null;
        return providers.find((provider) => provider.landingHosts?.includes(url.hostname)) || null;
      } catch { return null; }
    },
    get: (id) => providers.find((provider) => provider.id === id),
    match,
  };
})();
