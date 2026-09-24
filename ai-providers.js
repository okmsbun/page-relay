/* Integration-only registry. A recognized URL is NOT proof of send capability.
   Enable a sender only after checking its signed-in composer, both attachments,
   draft protection, and outgoing-turn confirmation. See INTEGRATIONS.md. */
const AIProviders = (() => {
  const providers = [
    { id: "chatgpt", name: "ChatGPT", hosts: ["chatgpt.com", "chat.openai.com"],
      route: /^(?:\/(?:c\/[^/]+|g\/[^/]+(?:\/c\/[^/]+)?)?)$/, conversation: /\/c\/[^/]+$/,
      sending: true },
    { id: "claude", name: "Claude", hosts: ["claude.ai"],
      route: /^\/(?:new|chat\/[^/]+)?$/, conversation: /^\/chat\/[^/]+$/ },
    { id: "gemini", name: "Gemini", hosts: ["gemini.google.com"],
      route: /^\/(?:u\/\d+\/)?app(?:\/[^/]+)?$/, conversation: /\/app\/[^/]+$/ },
    { id: "deepseek", name: "DeepSeek", hosts: ["chat.deepseek.com"],
      route: /^\/(?:a\/chat\/s\/[^/]+)?$/, conversation: /^\/a\/chat\/s\/[^/]+$/ },
    { id: "perplexity", name: "Perplexity", hosts: ["perplexity.ai", "www.perplexity.ai"],
      route: /^\/(?:search\/[^/]+)?$/, conversation: /^\/search\/[^/]+$/ },
    { id: "copilot", name: "Microsoft Copilot", hosts: ["copilot.microsoft.com"],
      route: /^\/(?:chats\/[^/]+)?$/, conversation: /^\/chats\/[^/]+$/ },
    { id: "grok", name: "Grok", hosts: ["grok.com"],
      route: /^\/(?:(?:c|chat)\/[^/]+)?$/, conversation: /^\/(?:c|chat)\/[^/]+$/ },
    { id: "mistral", name: "Mistral Le Chat", hosts: ["chat.mistral.ai"],
      route: /^\/(?:chat(?:\/[^/]+)?)?$/, conversation: /^\/chat\/[^/]+$/ },
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
    patterns: providers.flatMap((provider) => provider.hosts.map((host) => `https://${host}/*`)),
    get: (id) => providers.find((provider) => provider.id === id),
    match,
  };
})();
