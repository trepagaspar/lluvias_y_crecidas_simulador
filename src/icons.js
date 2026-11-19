// Iconografía SVG monocroma (estilo Lucide, 16px, trazo 1.75) — cero emojis en UI.

const SVG_PATHS = {
  search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
  compass: '<circle cx="12" cy="12" r="10"/><polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76"/>',
  book: '<path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20"/>',
  share: '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/>',
  camera: '<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/><circle cx="12" cy="13" r="3"/>',
  help: '<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
  sliders: '<line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/>',
  layers: '<polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/>',
  activity: '<polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>',
  waves: '<path d="M2 6c.6.5 1.2 1 2.5 1C7 7 7 5 9.5 5c2.6 0 2.4 2 5 2 2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1"/><path d="M2 12c.6.5 1.2 1 2.5 1 2.5 0 2.5-2 5-2 2.6 0 2.4 2 5 2 2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1"/><path d="M2 18c.6.5 1.2 1 2.5 1 2.5 0 2.5-2 5-2 2.6 0 2.4 2 5 2 2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1"/>',
  cloudRain: '<path d="M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242"/><path d="M16 14v6"/><path d="M8 14v6"/><path d="M12 16v6"/>',
  play: '<polygon points="6 3 20 12 6 21 6 3"/>',
  pause: '<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>',
  reset: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>',
  refresh: '<path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/><path d="M16 16h5v5"/>',
  crosshair: '<circle cx="12" cy="12" r="10"/><line x1="22" y1="12" x2="18" y2="12"/><line x1="6" y1="12" x2="2" y2="12"/><line x1="12" y1="6" x2="12" y2="2"/><line x1="12" y1="22" x2="12" y2="18"/>',
  droplet: '<path d="M12 2.69l5.66 5.66a8 8 0 1 1-11.31 0z"/>',
  pump: '<path d="M12 3v12"/><path d="m8 11 4 4 4-4"/><path d="M4 19h16"/>',
  menu: '<line x1="4" y1="6" x2="20" y2="6"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="18" x2="20" y2="18"/>',
  close: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
  chevronDown: '<polyline points="6 9 12 15 18 9"/>',
  chevronLeft: '<polyline points="15 18 9 12 15 6"/>',
  chevronRight: '<polyline points="9 18 15 12 9 6"/>',
  mapPin: '<path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/>',
  health: '<path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/><path d="M12 8v5"/><path d="M9.5 10.5h5"/>',
  school: '<path d="M22 10v6M2 10l10-5 10 5-10 5z"/><path d="M6 12v5c3 3 9 3 12 0v-5"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
  legend: '<rect x="3" y="3" width="18" height="18" rx="2"/><line x1="7" y1="8" x2="17" y2="8"/><line x1="7" y1="12" x2="17" y2="12"/><line x1="7" y1="16" x2="13" y2="16"/>',
  check: '<polyline points="20 6 9 17 4 12"/>',
  zap: '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>',
};

const SVG_NS = "http://www.w3.org/2000/svg";

export function createIcon(name, size = 15, className = "ico") {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.8");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  if (className) svg.setAttribute("class", className);

  const raw = SVG_PATHS[name] || "";
  if (raw) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(`<svg xmlns="${SVG_NS}">${raw}</svg>`, "image/svg+xml");
    for (const child of Array.from(doc.documentElement.childNodes)) {
      svg.appendChild(document.importNode(child, true));
    }
  }
  return svg;
}

export function hydrateIcons(root = document) {
  for (const host of root.querySelectorAll("[data-icon]")) {
    const name = host.getAttribute("data-icon");
    const size = parseInt(host.getAttribute("data-icon-size") || "15", 10);
    host.replaceChildren(createIcon(name, size));
  }
}

export function createSparklineSVG(records, alertVal = null, width = 72, height = 20) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("width", String(width));
  svg.setAttribute("height", String(height));
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("class", "sparkline");
  svg.setAttribute("aria-hidden", "true");

  const vals = (records || [])
    .map(r => Number(r.valor_m))
    .filter(v => Number.isFinite(v));

  if (vals.length < 2) return svg;

  let minV = Math.min(...vals);
  let maxV = Math.max(...vals);
  if (alertVal !== null && Number.isFinite(alertVal)) {
    minV = Math.min(minV, alertVal - 0.15);
    maxV = Math.max(maxV, alertVal + 0.15);
  }
  const span = Math.max(0.25, maxV - minV);
  const padY = 2.5;
  const innerH = height - padY * 2;
  const toY = v => height - padY - ((v - minV) / span) * innerH;

  if (alertVal !== null && Number.isFinite(alertVal)) {
    const line = document.createElementNS(SVG_NS, "line");
    const ay = toY(alertVal);
    line.setAttribute("x1", "0");
    line.setAttribute("x2", String(width));
    line.setAttribute("y1", ay.toFixed(1));
    line.setAttribute("y2", ay.toFixed(1));
    line.setAttribute("stroke", "rgba(245, 158, 11, 0.45)");
    line.setAttribute("stroke-width", "1");
    line.setAttribute("stroke-dasharray", "2 2");
    svg.appendChild(line);
  }

  const pts = vals.map((v, i) => {
    const x = (i / (vals.length - 1)) * (width - 4) + 2;
    const y = toY(v);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });

  const poly = document.createElementNS(SVG_NS, "polyline");
  poly.setAttribute("fill", "none");
  poly.setAttribute("stroke", "#38bdf8");
  poly.setAttribute("stroke-width", "1.6");
  poly.setAttribute("stroke-linecap", "round");
  poly.setAttribute("stroke-linejoin", "round");
  poly.setAttribute("points", pts.join(" "));
  svg.appendChild(poly);

  const last = vals[vals.length - 1];
  const dot = document.createElementNS(SVG_NS, "circle");
  dot.setAttribute("cx", String(width - 2));
  dot.setAttribute("cy", toY(last).toFixed(1));
  dot.setAttribute("r", "2.1");
  dot.setAttribute("fill", alertVal !== null && last >= alertVal ? "#f43f5e" : "#38bdf8");
  svg.appendChild(dot);

  return svg;
}
