/* DeepSeek integration only. A read-only capability probe; never reads draft
   contents, attaches files, clicks controls, or submits anything. */
function hasDeepSeekComposer(expectedUrl) {
  const currentUrl = `${location.origin}${location.pathname.replace(/\/+$/, "") || "/"}${location.search}`;
  if (currentUrl !== expectedUrl) return false;
  const visible = (node) => node.getClientRects().length > 0 &&
    getComputedStyle(node).visibility !== "hidden" && !node.closest('[inert],[aria-hidden="true"]');
  const editors = [...document.querySelectorAll('textarea, [contenteditable="true"][role="textbox"]')]
    .filter((node) => visible(node) && !node.disabled && !node.readOnly && node.getAttribute("aria-disabled") !== "true");
  // The observed composer identifies DeepSeek in its placeholder. File controls
  // are a fallback for localized composers, not a prerequisite for discovery
  // (some versions only mount them when the attachment menu is opened).
  const brandedComposer = editors.length === 1 && /deepseek/i.test([
    editors[0].getAttribute("placeholder"), editors[0].getAttribute("data-placeholder"),
    editors[0].getAttribute("aria-label"),
  ].join(" "));
  const upload = [...document.querySelectorAll('input[type="file"]')].some((node) => {
    if (node.disabled || !node.multiple) return false;
    const types = node.accept.toLowerCase().split(",").map((type) => type.trim());
    return !node.accept || types.includes("*/*") ||
      (types.some((type) => [".png", "image/png", "image/*"].includes(type)) &&
       types.some((type) => [".txt", "text/plain", "text/*"].includes(type)));
  });
  return editors.length === 1 && (brandedComposer || upload);
}
