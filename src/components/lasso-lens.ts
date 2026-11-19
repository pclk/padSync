// Keep typeset notes, paper and PDFs in the DOM so Safari magnifies them like the page.
// Only the small region of ink under the finger needs another bitmap.
export function createLassoLens(size: number, zoom: number, live: HTMLCanvasElement) {
  const lens = document.createElement("div");
  lens.inert = true;
  lens.setAttribute("aria-hidden", "true");
  lens.className = "pointer-events-none fixed z-50 overflow-hidden rounded-full bg-white shadow-lg ring-2 ring-slate-500";
  lens.style.width = lens.style.height = size + "px";
  const ink = document.createElement("canvas");
  const density = window.devicePixelRatio || 1;
  ink.width = ink.height = Math.round(size * density);
  ink.className = "absolute inset-0 h-full w-full";
  const cross = document.createElement("div");
  cross.className = "absolute inset-0 grid place-items-center text-blue-700";
  cross.style.textShadow = "0 0 2px white";
  cross.textContent = "+";
  lens.append(ink, cross);
  document.body.append(lens);
  let source: HTMLElement | null = null;
  let paper: HTMLElement | null = null;
  let x = 0, y = 0, frame = 0;

  function draw() {
    frame = 0;
    const section = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-section-id]") ?? null;
    if (source !== section) {
      paper?.remove();
      source = section;
      paper = section ? section.cloneNode(false) as HTMLElement : null;
      if (section && paper) {
        paper.removeAttribute("data-section-id");
        // Ink tiles are copied below. Cloning their canvases would allocate a second page of ink.
        for (const child of section.children) {
          if (!child.matches("[data-pdf-background], [data-margin], .section-content, [data-textbox]")) continue;
          paper.append(child.cloneNode(true));
        }
        for (const el of paper.querySelectorAll("[id]")) el.removeAttribute("id");
        paper.style.position = "absolute";
        paper.style.transformOrigin = "0 0";
        lens.prepend(paper);
      }
    }
    const ctx = ink.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, ink.width, ink.height);
    const scale = zoom * ink.width / size;
    ctx.setTransform(scale, 0, 0, scale, ink.width / 2 - x * scale, ink.height / 2 - y * scale);
    if (source && paper) {
      const r = source.getBoundingClientRect();
      paper.style.transform = `translate(${size / 2 + (r.left - x) * zoom}px,${size / 2 + (r.top - y) * zoom}px) scale(${zoom * r.width / source.offsetWidth})`;
    }
    const radius = size / (2 * zoom);
    for (const c of [...(source?.querySelectorAll("canvas") ?? []), live]) {
      const r = c.getBoundingClientRect();
      if (c.width && c.height && r.right > x - radius && r.left < x + radius && r.bottom > y - radius && r.top < y + radius)
        ctx.drawImage(c, r.left, r.top, r.width, r.height);
    }
    const above = y >= size + 26;
    const left = above ? x - size / 2 : x < innerWidth / 2 ? x + 26 : x - size - 26;
    lens.style.left = Math.max(4, Math.min(innerWidth - size - 4, left)) + "px";
    lens.style.top = Math.max(4, Math.min(innerHeight - size - 4, above ? y - size - 22 : y - size / 2)) + "px";
  }
  return {
    move(nextX: number, nextY: number) {
      x = nextX;
      y = nextY;
      if (!frame) frame = requestAnimationFrame(draw);
    },
    remove() {
      cancelAnimationFrame(frame);
      lens.remove();
      ink.width = ink.height = 0;
    },
  };
}
