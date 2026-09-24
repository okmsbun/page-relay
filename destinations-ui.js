const destinationUI = (() => {
  const section = document.getElementById("destinations");
  const list = document.getElementById("destinationList");
  const search = document.getElementById("destinationSearch");
  const refreshButton = document.getElementById("refreshDestinations");
  const sendButton = document.getElementById("sendCapture");
  const note = document.getElementById("destinationNote");
  let destinations = [];
  let selection = new Set();
  let statuses = new Map();
  let capture = null;
  let busy = false;
  let discovering = false;
  let generation = 0;
  // Only invoked by the explicit Send click, never by discovery or selection.
  let delivery = deliverToDestination;

  function updateButton() {
    const count = selection.size;
    sendButton.textContent = busy ? "Sending…" : count ? `Send to ${count} ${count === 1 ? "chat" : "chats"}` : "Select conversations";
    sendButton.disabled = busy || discovering || !count || !capture || !delivery;
    sendButton.title = delivery ? "" : "Sending requires a delivery method to be configured.";
  }

  function render() {
    list.replaceChildren();
    const query = search.value.trim().toLowerCase();
    const visible = destinations.filter((item) => `${item.providerName} ${item.title} ${item.label}`.toLowerCase().includes(query));
    for (const provider of AIProviders.all) {
      const items = visible.filter((item) => item.providerId === provider.id);
      if (!items.length) continue;
      const group = document.createElement("section");
      group.className = "destination-group";
      group.setAttribute("aria-label", provider.name);
      const heading = document.createElement("h3");
      heading.className = "destination-provider";
      heading.textContent = provider.name;
      group.append(heading);
      list.append(group);
      for (const item of items) {
        const row = document.createElement("div");
        row.className = "destination-row";
        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.id = `destination-${item.id}`;
        checkbox.setAttribute("aria-label", `${item.providerName}: ${item.title}, ${item.label}`);
        checkbox.checked = selection.has(item.id);
        checkbox.disabled = busy || discovering || !!item.unavailable || ["sent", "review", "unsupported"].includes(statuses.get(item.id)?.state);
        checkbox.addEventListener("change", () => {
          checkbox.checked ? selection.add(item.id) : selection.delete(item.id);
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
          const state = status?.state || (item.unsupported ? "unsupported" : "unavailable");
          const labels = { sent: "Sent", sending: "Sending…", failed: "Failed", review: "Needs review", unsupported: "Unsupported", unavailable: "Unavailable" };
          const feedback = document.createElement(["sent", "sending"].includes(state) ? "span" : "details");
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
        group.append(row);
      }
    }
    if (!visible.length) {
      const empty = document.createElement("p");
      empty.className = "destination-empty";
      empty.textContent = destinations.length ? "No matching conversations." : "No AI conversations found. Open a chat, then refresh.";
      list.append(empty);
    }
    search.hidden = destinations.length < 5 && !search.value;
    updateButton();
  }

  async function refresh() {
    if (busy) return;
    const version = ++generation;
    discovering = true;
    refreshButton.disabled = true;
    sendButton.disabled = true;
    note.textContent = "Finding conversations…";
    render();
    try {
      const found = await ChatDestinations.discover();
      if (version !== generation) return;
      const previous = new Map(destinations.map((item) => [item.id, item]));
      selection = new Set(found.filter((item) => selection.has(item.id) && !item.unavailable &&
        previous.get(item.id)?.url === item.url && previous.get(item.id)?.incognito === item.incognito).map((item) => item.id));
      statuses = new Map(found.filter((item) => previous.get(item.id)?.url === item.url ||
        (["sent", "review"].includes(statuses.get(item.id)?.state) && previous.get(item.id)?.providerId === item.providerId))
        .filter((item) => statuses.has(item.id)).map((item) => [item.id, statuses.get(item.id)]));
      destinations = found;
      note.textContent = delivery ? "" : "Selection available. Sending setup is pending.";
      render();
    } catch (error) {
      if (version !== generation) return;
      selection.clear(); destinations = []; render();
      note.textContent = `Could not find conversations: ${error.message}`;
    } finally {
      if (version === generation) { discovering = false; refreshButton.disabled = false; render(); }
    }
  }

  sendButton.addEventListener("click", async () => {
    if (busy || discovering || !capture || !delivery || !selection.size) return;
    const chosen = destinations.filter((item) => selection.has(item.id) && !item.unavailable &&
      !["sent", "review", "unsupported"].includes(statuses.get(item.id)?.state));
    busy = true;
    refreshButton.disabled = search.disabled = true;
    document.getElementById("takeScreenshot").disabled = true;
    note.textContent = "Keep popup open while sending.";
    try {
      const results = await ChatDestinations.sendSelected(chosen, capture, delivery, (id, result) => {
        statuses.set(id, result);
        if (["sent", "review", "unsupported"].includes(result.state)) selection.delete(id);
        render();
      });
      const sent = results.filter((result) => result.state === "sent").length;
      const review = results.filter((result) => result.state === "review").length;
      const unsupported = results.filter((result) => result.state === "unsupported").length;
      const failed = results.length - sent - review - unsupported;
      note.textContent = [`${sent} sent`, failed ? `${failed} failed` : "", review ? `${review} need review` : "", unsupported ? `${unsupported} unsupported` : ""].filter(Boolean).join(" · ");
    } finally {
      busy = false;
      refreshButton.disabled = search.disabled = false;
      document.getElementById("takeScreenshot").disabled = false;
      render();
    }
  });
  refreshButton.addEventListener("click", refresh);
  search.addEventListener("input", render);

  return {
    async show(result) {
      capture = result;
      selection.clear(); statuses.clear(); search.value = "";
      section.hidden = false;
      await refresh();
    },
    suspend() { ++generation; discovering = false; section.hidden = true; },
    resume() { if (capture) { section.hidden = false; void refresh(); } },
    configureDelivery(adapter) { delivery = adapter; updateButton(); },
  };
})();
