const destinationUI = (() => {
  const section = document.getElementById("destinations");
  const list = document.getElementById("destinationList");
  const search = document.getElementById("destinationSearch");
  const refreshButton = document.getElementById("refreshDestinations");
  const sendButton = document.getElementById("sendCapture");
  const note = document.getElementById("destinationNote");
  const tabs = document.getElementById("providerTabs");
  const emptyState = document.getElementById("noDestinations");
  let discoveryError = false;
  let activeProvider = null;
  let destinations = [];
  let selection = new Set();
  let statuses = new Map();
  let capture = null;
  let busy = false;
  let discovering = false;
  let generation = 0;
  // Only invoked by the explicit Add click, never by discovery or selection.
  let prepare = prepareInDestination;

  function updateButton() {
    const count = selection.size;
    sendButton.textContent = busy
      ? "Adding…"
      : count
        ? `Add to ${count} ${count === 1 ? "chat" : "chats"}`
        : "Select conversations";
    sendButton.disabled = busy || discovering || !count || !capture || !prepare;
    sendButton.title = prepare
      ? "The capture is added to the chat draft. You review and send it."
      : "Adding requires a preparation method to be configured.";
  }

  function render() {
    list.replaceChildren();
    const noChats = destinations.length === 0;
    emptyState.hidden = !noChats || discovering || discoveryError;
    list.hidden = sendButton.hidden = noChats;
    const query = search.value.trim().toLowerCase();
    const providers = AIProviders.all.filter((provider) =>
      destinations.some((item) => item.providerId === provider.id),
    );
    if (!providers.some((provider) => provider.id === activeProvider))
      activeProvider = providers[0]?.id || null;
    renderTabs(providers);
    list.setAttribute(
      "aria-labelledby",
      activeProvider ? `provider-${activeProvider}` : "providerTabs",
    );
    const visible = destinations.filter(
      (item) =>
        item.providerId === activeProvider &&
        `${item.providerName} ${item.title} ${item.label}`
          .toLowerCase()
          .includes(query),
    );
    {
      const items = visible;
      for (const item of items) {
        const row = document.createElement("div");
        row.className = "destination-row";
        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.id = `destination-${item.id}`;
        checkbox.setAttribute(
          "aria-label",
          `${item.providerName}: ${item.title}, ${item.label}`,
        );
        checkbox.checked = selection.has(item.id);
        checkbox.disabled =
          busy ||
          discovering ||
          !!item.unavailable ||
          ["prepared", "review", "unsupported"].includes(
            statuses.get(item.id)?.state,
          );
        checkbox.addEventListener("change", () => {
          checkbox.checked ? selection.add(item.id) : selection.delete(item.id);
          renderTabs(providers);
          updateButton();
        });
        const description = document.createElement("div");
        description.className = "destination-description";
        const title = document.createElement("label");
        title.htmlFor = checkbox.id;
        title.className = "destination-title";
        title.textContent = item.title;
        title.title = item.title;
        const details = document.createElement("span");
        details.className = "destination-detail";
        details.textContent = item.label;
        description.append(title, details);
        const status = statuses.get(item.id);
        if (status || item.unavailable) {
          const state = status?.state || "unavailable";
          const labels = {
            prepared: "Added",
            preparing: "Adding…",
            busy: "Busy · Generating a response",
            failed: "Failed",
            review: "Needs review",
            unsupported: "Unsupported",
            unavailable: "Unavailable",
          };
          const feedback = document.createElement(
            ["prepared", "preparing"].includes(state) ? "span" : "details",
          );
          feedback.className = `destination-feedback ${state}`;
          if (feedback.tagName === "DETAILS") {
            const summary = document.createElement("summary");
            summary.textContent = labels[state];
            const reason = document.createElement("span");
            reason.textContent = status?.message || item.unavailable;
            feedback.append(summary, reason);
          } else feedback.textContent = labels[state];
          description.append(feedback);
        }
        row.append(checkbox, description);
        list.append(row);
      }
    }
    if (!visible.length) {
      const empty = document.createElement("p");
      empty.className = "destination-empty";
      empty.textContent = destinations.length
        ? "No matching conversations."
        : "No AI conversations found. Open a chat, then refresh.";
      list.append(empty);
    }
    search.hidden = noChats || (destinations.length < 5 && !search.value);
    updateButton();
  }

  function selectProvider(id, focus = false) {
    activeProvider = id;
    search.value = "";
    render();
    list.scrollTop = 0;
    const tab = document.getElementById(`provider-${id}`);
    if (focus) tab?.focus();
    tab?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  function renderTabs(providers) {
    const scroll = tabs.scrollLeft;
    const focused = tabs.contains(document.activeElement)
      ? document.activeElement.id
      : null;
    tabs.replaceChildren();
    for (const provider of providers) {
      const tab = document.createElement("button");
      tab.type = "button";
      tab.className = "provider-tab";
      tab.id = `provider-${provider.id}`;
      tab.setAttribute("role", "tab");
      tab.setAttribute("aria-selected", String(activeProvider === provider.id));
      tab.setAttribute("aria-controls", "destinationList");
      tab.tabIndex = activeProvider === provider.id ? 0 : -1;
      const icon = document.createElement("span");
      icon.className = `provider-icon provider-icon-${provider.id}`;
      icon.setAttribute("aria-hidden", "true");
      icon.textContent = {
        chatgpt: "◎",
        claude: "✳",
        gemini: "✦",
      }[provider.id];
      const favicon = destinations.find(
        (item) => item.providerId === provider.id && item.favicon,
      )?.favicon;
      if (favicon) {
        const image = document.createElement("img");
        image.alt = "";
        image.referrerPolicy = "no-referrer";
        image.addEventListener("load", () => icon.replaceChildren(image), {
          once: true,
        });
        image.src = favicon;
      }
      const label = document.createElement("span");
      label.textContent = provider.name;
      tab.append(icon, label);
      const count = destinations.filter(
        (item) => item.providerId === provider.id && selection.has(item.id),
      ).length;
      if (count) {
        const badge = document.createElement("span");
        badge.className = "provider-count";
        badge.textContent = count;
        tab.append(badge);
      }
      const results = destinations
        .filter((item) => item.providerId === provider.id)
        .map((item) => statuses.get(item.id)?.state);
      tab.classList.toggle(
        "has-attention",
        results.some((state) => ["failed", "review"].includes(state)),
      );
      tab.classList.toggle("has-busy", results.includes("busy"));
      tab.title = [
        provider.name,
        count ? `${count} selected` : "",
        ...new Set(results.filter(Boolean)),
      ]
        .filter(Boolean)
        .join(" · ");
      tab.setAttribute("aria-label", tab.title);
      tab.addEventListener("click", () => selectProvider(provider.id));
      tab.addEventListener("keydown", (event) => {
        const index = providers.indexOf(provider);
        const next = {
          ArrowRight: (index + 1) % providers.length,
          ArrowLeft: (index - 1 + providers.length) % providers.length,
          Home: 0,
          End: providers.length - 1,
        }[event.key];
        if (next === undefined) return;
        event.preventDefault();
        selectProvider(providers[next].id, true);
      });
      tabs.append(tab);
    }
    tabs.hidden = !providers.length;
    tabs.scrollLeft = scroll;
    if (focused)
      document.getElementById(focused)?.focus({ preventScroll: true });
  }

  async function refresh() {
    if (busy) return;
    const version = ++generation;
    discovering = true;
    discoveryError = false;
    refreshButton.disabled = true;
    sendButton.disabled = true;
    note.textContent = "Finding conversations…";
    render();
    try {
      const overview = await ChatDestinations.discoverOverview();
      if (version !== generation) return;
      const found = overview.destinations;
      const previous = new Map(destinations.map((item) => [item.id, item]));
      selection = new Set(
        found
          .filter(
            (item) =>
              selection.has(item.id) &&
              !item.unavailable &&
              previous.get(item.id)?.url === item.url &&
              previous.get(item.id)?.incognito === item.incognito,
          )
          .map((item) => item.id),
      );
      statuses = new Map(
        found
          .filter(
            (item) =>
              previous.get(item.id)?.url === item.url ||
              (["prepared", "review"].includes(statuses.get(item.id)?.state) &&
                previous.get(item.id)?.providerId === item.providerId),
          )
          .filter((item) => statuses.has(item.id))
          .map((item) => [item.id, statuses.get(item.id)]),
      );
      destinations = found;
      note.textContent = prepare
        ? ""
        : "Selection available. Preparation setup is pending.";
      render();
    } catch (error) {
      if (version !== generation) return;
      discoveryError = true;
      selection.clear();
      destinations = [];
      render();
      note.textContent = `Could not find conversations: ${error.message}`;
    } finally {
      if (version === generation) {
        discovering = false;
        refreshButton.disabled = false;
        render();
      }
    }
  }

  sendButton.addEventListener("click", async () => {
    if (busy || discovering || !capture || !prepare || !selection.size) return;
    const chosen = destinations.filter(
      (item) =>
        selection.has(item.id) &&
        !item.unavailable &&
        !["prepared", "review", "unsupported"].includes(
          statuses.get(item.id)?.state,
        ),
    );
    busy = true;
    refreshButton.disabled = search.disabled = true;
    note.textContent = "Keep the Side Panel open while the capture is added.";
    try {
      const results = await ChatDestinations.prepareSelected(
        chosen,
        capture,
        prepare,
        (id, result) => {
          statuses.set(id, result);
          if (
            ["prepared", "review", "unsupported", "unavailable"].includes(
              result.state,
            )
          )
            selection.delete(id);
          render();
        },
      );
      const prepared = results.filter(
        (result) => result.state === "prepared",
      ).length;
      const review = results.filter(
        (result) => result.state === "review",
      ).length;
      const unsupported = results.filter(
        (result) => result.state === "unsupported",
      ).length;
      const unavailable = results.filter(
        (result) => result.state === "unavailable",
      ).length;
      const waiting = results.filter(
        (result) => result.state === "busy",
      ).length;
      const failed = results.filter(
        (result) => result.state === "failed",
      ).length;
      note.textContent = [
        `${prepared} added to a chat draft`,
        waiting ? `${waiting} busy (wait, then click Add again)` : "",
        failed ? `${failed} failed` : "",
        review ? `${review} need review` : "",
        unsupported ? `${unsupported} unsupported` : "",
        unavailable ? `${unavailable} unavailable` : "",
      ]
        .filter(Boolean)
        .join(" · ");
    } finally {
      busy = false;
      refreshButton.disabled = search.disabled = false;
      render();
    }
  });
  refreshButton.addEventListener("click", refresh);
  search.addEventListener("input", render);

  return {
    async show(result) {
      capture = result;
      selection.clear();
      statuses.clear();
      search.value = "";
      section.hidden = false;
      await refresh();
    },
    suspend() {
      ++generation;
      discovering = false;
      section.hidden = true;
    },
    resume() {
      if (capture) {
        section.hidden = false;
        void refresh();
      }
    },
    configurePreparation(adapter) {
      prepare = adapter;
      updateButton();
    },
  };
})();
