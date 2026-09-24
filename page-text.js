(() => {
  if (globalThis.PageTextCollector) return;

  // Session-local, rendered DOM text. Never retain live nodes in the final result.
  globalThis.PageTextCollector = class PageTextCollector {
    constructor(targets) {
      this.targets = targets;
      this.groups = new Map();
      this.characters = 0;
      this.sequence = 0;
      this.blocks = new WeakMap();
      this.persistentNodes = new WeakMap();
      this.positions = new Map();
      this.nextBlock = 0;
      this.truncated = false;
    }

    sample() {
      if (this.truncated || !document.body) return;
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      const range = document.createRange();
      const styles = new Map();
      const styleOf = (element) => {
        if (!styles.has(element)) styles.set(element, getComputedStyle(element));
        return styles.get(element);
      };
      let node;
      while ((node = walker.nextNode())) {
        const parent = node.parentElement;
        if (!parent || !node.textContent || parent.closest("script,style,noscript,template")) continue;
        const owner = this.targets.find((element) => element.contains(parent));
        let block = parent;
        while (block.parentElement && /^(inline|contents)/.test(styleOf(block).display)) block = block.parentElement;
        let hidden = false;
        let persistent = false;
        let clip = { left: 0, top: 0, right: innerWidth, bottom: innerHeight };
        for (let element = parent; element; element = element.parentElement) {
          const style = styleOf(element);
          if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse" || Number(style.opacity) === 0) {
            hidden = true;
            break;
          }
          if ((style.position === "fixed" || style.position === "sticky") &&
              (!owner || (element !== owner && owner.contains(element)))) persistent = true;
          if (element !== document.body && element !== document.documentElement) {
            const rect = element.getBoundingClientRect();
            if (/auto|scroll|hidden|clip/.test(style.overflowX)) {
              clip.left = Math.max(clip.left, rect.left); clip.right = Math.min(clip.right, rect.right);
            }
            if (/auto|scroll|hidden|clip/.test(style.overflowY)) {
              clip.top = Math.max(clip.top, rect.top); clip.bottom = Math.min(clip.bottom, rect.bottom);
            }
          }
        }
        if (hidden) continue;
        range.selectNodeContents(node);
        const rects = [...range.getClientRects()];
        if (!rects.some((rect) => rect.width > 0 && rect.height > 0 &&
          rect.bottom > clip.top && rect.top < clip.bottom && rect.right > clip.left && rect.left < clip.right)) continue;
        const rect = rects[0];
        const origin = owner?.getBoundingClientRect();
        const groupId = owner ? this.targets.indexOf(owner) : -1;
        // Selected regions use their own content coordinates. The app frame uses
        // viewport coordinates; ordinary documents use document coordinates.
        const frame = this.targets.length > 0 || persistent;
        const x = rect.left - (origin?.left || 0) + (owner ? owner.scrollLeft : frame ? 0 : scrollX);
        const y = rect.top - (origin?.top || 0) + (owner ? owner.scrollTop : frame ? 0 : scrollY);
        const preserve = /pre|break-spaces/.test(styleOf(parent).whiteSpace);
        const text = preserve ? node.textContent : node.textContent.replace(/\s+/g, " ");
        if (this.persistentNodes.get(node)?.has(text)) continue;
        if (persistent) {
          if (!this.persistentNodes.has(node)) this.persistentNodes.set(node, new Set());
          this.persistentNodes.get(node).add(text);
        }
        let group = this.groups.get(groupId);
        if (!group) { group = []; this.groups.set(groupId, group); }
        // Content + position, not content alone: identical labels in different
        // rows/columns remain distinct, including when a virtualizer reuses nodes.
        const key = JSON.stringify([groupId, text]);
        const positions = this.positions.get(key) || [];
        if (positions.some((entry) => Math.abs(entry.x - x) <= 2 && Math.abs(entry.y - y) <= 2)) continue;
        if (this.characters + text.length > 2_000_000) { this.truncated = true; break; }
        if (!this.blocks.has(block)) this.blocks.set(block, ++this.nextBlock);
        group.push({ text, x, y, block: this.blocks.get(block), sequence: this.sequence++ });
        positions.push({ x, y });
        this.positions.set(key, positions);
        this.characters += text.length;
      }
      range.detach();
    }

    stats() {
      return { characters: this.characters, estimatedTokens: Math.ceil(this.characters / 4), truncated: this.truncated };
    }

    result() {
      // App context first, then columns in visual reading order, not capture order.
      const order = [-1, ...this.targets.map((element, index) => ({ index, rect: element.getBoundingClientRect() }))
        .sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left).map((item) => item.index)];
      const text = order.map((id) => {
        const entries = [...(this.groups.get(id) || [])].sort((a, b) => a.y - b.y || a.x - b.x || a.sequence - b.sequence);
        let previous;
        return entries.map((entry) => {
          const separator = !previous ? "" : entry.block === previous.block && Math.abs(entry.y - previous.y) < 3 ? "" : "\n";
          previous = entry;
          return separator + entry.text;
        }).join("").replace(/^\n+|\n+$/g, "");
      }).filter((text) => text.trim()).join("\n\n");
      return { text, characters: text.length, estimatedTokens: Math.ceil(text.length / 4),
        truncated: this.truncated, title: document.title, url: location.href };
    }
  };
})();
