const destinationUI = (() => {
  const section = document.getElementById("destinations");
  const list = document.getElementById("destinationList");
  const search = document.getElementById("destinationSearch");
  const refreshButton = document.getElementById("refreshDestinations");
  const sendButton = document.getElementById("sendCapture");
  const includePageText = document.getElementById("includePageText");
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
  let defaultSelectionApplied = false;
  let userTouchedSelection = false;
  const busyListeners = new Set();
  // Only invoked by the explicit Add click, never by discovery or selection.
  let prepare = prepareInDestination;

  function setBusy(next) {
    if (busy === next) return;
    busy = next;
    for (const listener of busyListeners) listener(busy);
  }

  function attachmentStates(status) {
    if (status?.attachments) return status.attachments;
    if (!status?.state) return { png: null, txt: null };
    return { png: status.state, txt: null };
  }

  function pendingKindsFor(item, wantTxt = includePageText.checked) {
    if (item.unavailable) return [];
    const status = statuses.get(item.id);
    const { png, txt } = attachmentStates(status);
    if (["review", "unsupported"].includes(png)) return [];
    if (wantTxt && ["review", "unsupported"].includes(txt)) return [];
    const needed = [];
    if (png !== "prepared") needed.push("png");
    if (wantTxt && txt !== "prepared") needed.push("txt");
    return needed;
  }

  function isEligible(item) {
    return pendingKindsFor(item).length > 0;
  }

  function isProtectedState(status) {
    if (!status) return false;
    const { png, txt } = attachmentStates(status);
    return (
      ["prepared", "review"].includes(png) ||
      ["prepared", "review"].includes(txt) ||
      ["prepared", "review"].includes(status.state)
    );
  }

  function applyDefaultSelection() {
    if (defaultSelectionApplied || userTouchedSelection || selection.size > 0)
      return;
    const providers = AIProviders.all.filter((provider) =>
      destinations.some((item) => item.providerId === provider.id),
    );
    if (!providers.length) return;
    const orderedProviders = providers.some(
      (provider) => provider.id === activeProvider,
    )
      ? [
          providers.find((provider) => provider.id === activeProvider),
          ...providers.filter((provider) => provider.id !== activeProvider),
        ]
      : providers;
    for (const provider of orderedProviders) {
      const first = destinations.find(
        (item) => item.providerId === provider.id && isEligible(item),
      );
      if (first) {
        activeProvider = provider.id;
        selection.add(first.id);
        defaultSelectionApplied = true;
        return;
      }
    }
  }

  function formatActionLabel(selectedItems) {
    const count = selectedItems.length;
    if (!count) return "Select conversations";
    const signatures = new Set(
      selectedItems.map((item) => pendingKindsFor(item).join("+")),
    );
    if (signatures.size === 1) {
      const only = [...signatures][0];
      if (only === "png") {
        return count === 1
          ? "Add screenshot"
          : `Add screenshot to ${count} chats`;
      }
      if (only === "txt") {
        return count === 1
          ? "Add page text"
          : `Add page text to ${count} chats`;
      }
      if (only === "png+txt") {
        return count === 1
          ? "Add screenshot and text"
          : `Add screenshot and text to ${count} chats`;
      }
    }
    return count === 1 ? "Add to 1 chat" : `Add to ${count} chats`;
  }

  function updateButton() {
    const selectedItems = destinations.filter(
      (item) => selection.has(item.id) && isEligible(item),
    );
    const count = selectedItems.length;
    sendButton.textContent = busy
      ? "Adding…"
      : formatActionLabel(selectedItems);
    sendButton.disabled = busy || discovering || !count || !capture || !prepare;
    sendButton.title = prepare
      ? "The capture is added to the chat draft. You review and send it."
      : "Adding requires a preparation method to be configured.";
  }

  function deliveredBadgeText(attachments) {
    const hasPng = attachments.png === "prepared";
    const hasTxt = attachments.txt === "prepared";
    if (hasPng && hasTxt) return "Screenshot and text added";
    if (hasPng) return "Screenshot added";
    if (hasTxt) return "Page text added";
    return null;
  }

  function activeIssueFor(item, status) {
    if (item.unavailable) {
      return { state: "unavailable", message: item.unavailable, kind: null };
    }
    if (!status) return null;
    const { png, txt } = attachmentStates(status);
    if (status.state === "preparing" || png === "preparing" || txt === "preparing") {
      const label =
        png === "prepared" && txt === "preparing"
          ? "Adding page text…"
          : "Adding…";
      return { state: "preparing", label, message: status.message };
    }
    const attention = ["review", "failed", "busy", "unsupported", "unavailable"];
    if (attention.includes(png)) {
      return {
        state: png,
        message: status.pngMessage || status.message,
        kind: "png",
      };
    }
    if (attention.includes(txt)) {
      return {
        state: txt,
        message: status.txtMessage || status.message,
        kind: "txt",
      };
    }
    if (attention.includes(status.state)) {
      return { state: status.state, message: status.message, kind: null };
    }
    return null;
  }

  function rowDatasetState(item, status) {
    if (item.unavailable) return "unavailable";
    const issue = activeIssueFor(item, status);
    if (issue) return issue.state;
    const { png, txt } = attachmentStates(status);
    if (png === "prepared" && (!includePageText.checked || txt === "prepared"))
      return "prepared";
    if (png === "prepared" || txt === "prepared") return "partial";
    return "ready";
  }

  function providerAttentionStates(providerId) {
    return destinations
      .filter((item) => item.providerId === providerId)
      .map((item) => activeIssueFor(item, statuses.get(item.id))?.state)
      .filter(Boolean);
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
    for (const item of visible) {
      const row = document.createElement("div");
      row.className = "destination-row";
      const status = statuses.get(item.id);
      const attachments = attachmentStates(status);
      const eligible = isEligible(item);
      row.dataset.state = rowDatasetState(item, status);
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.id = `destination-${item.id}`;
      checkbox.setAttribute(
        "aria-label",
        `${item.providerName}: ${item.title}, ${item.label}`,
      );
      checkbox.checked = eligible && selection.has(item.id);
      checkbox.disabled = busy || discovering || !eligible;
      checkbox.addEventListener("change", () => {
        userTouchedSelection = true;
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

      const deliveredText = deliveredBadgeText(attachments);
      const issue = activeIssueFor(item, status);
      if (deliveredText || issue) {
        const feedbackRow = document.createElement("div");
        feedbackRow.className = "destination-feedback-group";
        if (deliveredText) {
          const badge = document.createElement("span");
          badge.className = "destination-feedback prepared";
          badge.textContent = deliveredText;
          feedbackRow.append(badge);
        }
        if (issue) {
          const labels = {
            preparing: issue.label || "Adding…",
            busy: issue.message?.startsWith("Generating a response")
              ? "Busy · Generating a response"
              : "Busy",
            failed:
              deliveredText && issue.kind === "txt"
                ? "Page text failed"
                : "Failed",
            review:
              deliveredText && issue.kind === "txt"
                ? "Page text needs review"
                : "Needs review",
            unsupported: "Unsupported",
            unavailable: "Unavailable",
          };
          const feedback = document.createElement(
            issue.state === "preparing" ? "span" : "details",
          );
          feedback.className = `destination-feedback ${issue.state}`;
          if (feedback.tagName === "DETAILS") {
            const summary = document.createElement("summary");
            summary.textContent = labels[issue.state];
            const reason = document.createElement("span");
            reason.textContent = issue.message || item.unavailable;
            feedback.append(summary, reason);
          } else {
            feedback.textContent = labels[issue.state];
          }
          feedbackRow.append(feedback);
        } else if (deliveredText && eligible && includePageText.checked) {
          const readyHint = document.createElement("span");
          readyHint.className = "destination-feedback followup";
          readyHint.textContent = "Ready for page text";
          feedbackRow.append(readyHint);
        }
        description.append(feedbackRow);
      }
      row.append(checkbox, description);
      // The whole visible row selects the chat. Preserve native label/checkbox
      // activation and let expandable feedback remain independently interactive.
      row.addEventListener("click", (event) => {
        if (event.target.closest("input, label, details, button, a")) return;
        if (!checkbox.disabled) checkbox.click();
      });
      list.append(row);
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
        (item) =>
          item.providerId === provider.id &&
          selection.has(item.id) &&
          isEligible(item),
      ).length;
      if (count) {
        const badge = document.createElement("span");
        badge.className = "provider-count";
        badge.textContent = count;
        tab.append(badge);
      }
      const results = providerAttentionStates(provider.id);
      tab.classList.toggle(
        "has-attention",
        results.some((state) => ["failed", "review"].includes(state)),
      );
      tab.classList.toggle("has-busy", results.includes("busy"));
      tab.title = [
        provider.name,
        count ? `${count} selected` : "",
        ...new Set(results),
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
    refreshButton.dataset.discovering = "true";
    sendButton.disabled = true;
    note.textContent = "Finding conversations…";
    render();
    try {
      const overview = await ChatDestinations.discoverOverview();
      if (version !== generation) return;
      const found = overview.destinations;
      const previous = new Map(destinations.map((item) => [item.id, item]));
      statuses = new Map(
        found
          .filter(
            (item) =>
              previous.get(item.id)?.url === item.url ||
              (isProtectedState(statuses.get(item.id)) &&
                previous.get(item.id)?.providerId === item.providerId),
          )
          .filter((item) => statuses.has(item.id))
          .map((item) => [item.id, statuses.get(item.id)]),
      );
      selection = new Set(
        found
          .filter(
            (item) =>
              selection.has(item.id) &&
              isEligible(item) &&
              previous.get(item.id)?.url === item.url &&
              previous.get(item.id)?.incognito === item.incognito,
          )
          .map((item) => item.id),
      );
      destinations = found;
      applyDefaultSelection();
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
        delete refreshButton.dataset.discovering;
        render();
      }
    }
  }

  includePageText.addEventListener("change", () => {
    if (busy) return;
    // Prune selections that are no longer eligible when turning page text off,
    // while keeping previously delivered attachments and eligible selections intact.
    for (const id of [...selection]) {
      const item = destinations.find((entry) => entry.id === id);
      if (!item || !isEligible(item)) selection.delete(id);
    }
    render();
  });

  sendButton.addEventListener("click", async () => {
    if (busy || discovering || !capture || !prepare || !selection.size) return;
    const chosen = destinations.filter(
      (item) => selection.has(item.id) && isEligible(item),
    );
    if (!chosen.length) return;
    setBusy(true);
    capture.includeText = includePageText.checked;
    includePageText.disabled = true;
    refreshButton.disabled = search.disabled = true;
    note.textContent = "Keep the Side Panel open while the capture is added.";
    try {
      const results = await ChatDestinations.prepareSelected(
        chosen,
        capture,
        prepare,
        (id, result) => {
          statuses.set(id, result);
          const item = destinations.find((entry) => entry.id === id);
          if (
            ["prepared", "review", "unsupported", "unavailable"].includes(
              result.state,
            ) ||
            (item && !isEligible(item))
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
      setBusy(false);
      includePageText.disabled = false;
      refreshButton.disabled = search.disabled = false;
      render();
    }
  });
  refreshButton.addEventListener("click", refresh);
  search.addEventListener("input", render);

  return {
    async show(result) {
      capture = result;
      includePageText.checked = false;
      selection.clear();
      statuses.clear();
      defaultSelectionApplied = false;
      userTouchedSelection = false;
      search.value = "";
      section.hidden = false;
      await refresh();
    },
    suspend() {
      ++generation;
      discovering = false;
      delete refreshButton.dataset.discovering;
      section.hidden = true;
    },
    resume() {
      if (capture) {
        section.hidden = false;
        void refresh();
      }
    },
    isBusy: () => busy,
    onBusyChange(listener) {
      busyListeners.add(listener);
    },
    configurePreparation(adapter) {
      prepare = adapter;
      updateButton();
    },
  };
})();
