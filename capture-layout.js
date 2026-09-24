// Partition the app into vertical strips at panel edges. This keeps independent
// columns (including stacked panels next to a tall sidebar) from overlapping.
function planApplicationLayout(shell, panels, metrics) {
  const sx = shell.width / metrics.windowWidth;
  const sy = shell.height / metrics.windowHeight;
  const regions = panels.map((panel) => {
    const { crop } = panel;
    const x = Math.round(crop.x * sx);
    const top = Math.round(crop.y * sy);
    return { ...panel, x, top,
      right: Math.round((crop.x + crop.width) * sx),
      bottom: Math.round((crop.y + crop.height) * sy) };
  }).sort((a, b) => a.top - b.top);
  const edges = [...new Set([0, shell.width, ...regions.flatMap((r) => [r.x, r.right])])].sort((a, b) => a - b);
  const strips = edges.slice(0, -1).map((x, index) => {
    const right = edges[index + 1];
    const contents = regions.filter((r) => r.x <= x && r.right >= right);
    for (let i = 1; i < contents.length; i++) {
      if (contents[i].top < contents[i - 1].bottom) {
        throw new Error("The scrolling areas overlap. Please close overlapping panels and retry.");
      }
    }
    return { x, width: right - x, regions: contents,
      extra: contents.reduce((sum, r) => sum + r.canvas.height - (r.bottom - r.top), 0) };
  });
  const extra = Math.max(0, ...strips.map((strip) => strip.extra));
  return { strips, extra, width: shell.width, height: shell.height + extra,
    frameBottom: Math.max(...regions.map((r) => r.bottom)) };
}

function composeApplicationScreenshot(shell, panels, metrics) {
  const plan = planApplicationLayout(shell, panels, metrics);
  checkCanvasSize(plan.width, plan.height);
  const canvas = document.createElement("canvas");
  canvas.width = plan.width;
  canvas.height = plan.height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Could not allocate the application screenshot.");
  const background = metrics.background || "#ffffff";
  context.fillStyle = background;
  context.fillRect(0, 0, canvas.width, canvas.height);

  for (const strip of plan.strips) {
    let sourceY = 0;
    let destY = 0;
    const copyFrameTo = (bottom) => {
      const height = bottom - sourceY;
      if (height > 0) context.drawImage(shell, strip.x, sourceY, strip.width, height,
        strip.x, destY, strip.width, height);
      destY += height;
      sourceY = bottom;
    };
    for (const region of strip.regions) {
      copyFrameTo(region.top);
      context.drawImage(region.canvas, strip.x - region.x, 0, strip.width, region.canvas.height,
        strip.x, destY, strip.width, region.canvas.height);
      destY += region.canvas.height;
      sourceY = region.bottom;
    }
    if (!strip.regions.length) copyFrameTo(plan.frameBottom);
    // Extend empty background, never sidebar text or controls, to align the footer.
    const padding = plan.extra - strip.extra;
    context.fillStyle = strip.regions.at(-1)?.background || background;
    context.fillRect(strip.x, destY, strip.width, padding);
    destY += padding;
    copyFrameTo(shell.height);
  }
  return canvas;
}
