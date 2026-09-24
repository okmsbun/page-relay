/* Supported-provider registry. A recognized URL is not enough: a provider is listed in
   the UI only when this extension has a complete composer-preparation integration for it
   (see INTEGRATIONS.md). Preparation never submits - it attaches the capture, inserts the
   prompt, and leaves the message for the user to review and send. */
const AIProviders = (() => {
  const providers = [
    {
      id: "chatgpt",
      name: "ChatGPT",
      hosts: ["chatgpt.com", "chat.openai.com"],
      route: /^(?:\/(?:c\/[^/]+|g\/[^/]+(?:\/c\/[^/]+)?)?)$/,
      conversation: /\/c\/[^/]+$/,
      preparation: true,
    },
    {
      id: "claude",
      name: "Claude",
      hosts: ["claude.ai"],
      route: /^\/(?:new|chat\/[^/]+)?$/,
      conversation: /^\/chat\/[^/]+$/,
      preparation: true,
    },
    {
      id: "gemini",
      name: "Gemini",
      hosts: ["gemini.google.com"],
      route: /^\/(?:u\/\d+\/)?app(?:\/[^/]+)?$/,
      conversation: /\/app\/[^/]+$/,
      preparation: true,
    },
  ];
  function match(rawUrl) {
    try {
      const url = new URL(rawUrl);
      if (url.protocol !== "https:" || url.port || url.username || url.password)
        return null;
      const path = url.pathname.replace(/\/+$/, "") || "/";
      const provider = providers.find(
        (item) => item.hosts.includes(url.hostname) && item.route.test(path),
      );
      if (!provider) return null;
      const identity = `${url.origin}${path}${url.search}`;
      const conversation = provider.conversation.test(path);
      return { provider, url: identity, conversation };
    } catch {
      return null;
    }
  }
  return {
    all: providers,
    patterns: providers.flatMap((provider) =>
      provider.hosts.map((host) => `https://${host}/*`),
    ),
    get: (id) => providers.find((provider) => provider.id === id),
    supported: (provider) => provider?.preparation === true,
    match,
  };
})();
