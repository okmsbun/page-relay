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
      landingHosts: ["www.deepseek.com", "deepseek.com"],
      limitation: "DeepSeek sending is not implemented. Its composer and file control were inspected, but screenshot/text acceptance, draft protection, and delivery confirmation remain unverified.",
      route: /^\/(?:a\/chat\/s\/[^/]+)?$/, conversation: /^\/a\/chat\/s\/[^/]+$/ },
    { id: "copilot", name: "Microsoft Copilot", hosts: ["copilot.microsoft.com"],
      limitation: "Copilot sending is not implemented. Live verification reached account authorization consent; uploads, draft protection, and delivery confirmation remain unverified.",
      route: /^\/(?:chats\/[^/]+)?$/, conversation: /^\/chats\/[^/]+$/ },
  ];
  function match(rawUrl) {
    try {
      const url = new URL(rawUrl);
      if (url.protocol !== "https:" || url.port || url.username || url.password) return null;
      const path = url.pathname.replace(/\/+$/, "") || "/";
      const provider = providers.find((item) =>
        (item.hosts.includes(url.hostname) && item.route.test(path)) ||
        (item.landingHosts?.includes(url.hostname) && /^\/(?:en|zh)?$/.test(path)));
      if (!provider) return null;
      const identity = `${url.origin}${path}${url.search}`;
      const conversation = provider.conversation.test(path);
      return { provider, url: identity, conversation,
        requiresComposer: provider.id === "deepseek" && !conversation };
    } catch { return null; }
  }
  return {
    all: providers,
    patterns: providers.flatMap((provider) => [...provider.hosts, ...(provider.landingHosts || [])].map((host) => `https://${host}/*`)),
    get: (id) => providers.find((provider) => provider.id === id),
    match,
  };
})();
