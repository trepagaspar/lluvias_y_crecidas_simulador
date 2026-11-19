// Utilidades de formato numérico consistente es-AR y construcción segura de DOM (sin innerHTML).

const NUM_FORMATTERS = new Map();

function getFormatter(decimals) {
  if (!NUM_FORMATTERS.has(decimals)) {
    NUM_FORMATTERS.set(
      decimals,
      new Intl.NumberFormat("es-AR", {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals,
      })
    );
  }
  return NUM_FORMATTERS.get(decimals);
}

export function fmtNum(val, decimals = 2) {
  const n = Number(val);
  if (!Number.isFinite(n)) return "--";
  return getFormatter(decimals).format(n);
}

export function fmtInt(val) {
  const n = Math.round(Number(val));
  if (!Number.isFinite(n)) return "--";
  return getFormatter(0).format(n);
}

export function fmtDelta(d) {
  const n = Number(d);
  if (!Number.isFinite(n) || Math.abs(n) < 0.005) return "(=)";
  return (n > 0 ? "(+" : "(-") + fmtNum(Math.abs(n), 2) + " m)";
}

export function fmtShortDate(iso) {
  if (!iso) return "";
  const dt = new Date(iso);
  if (Number.isNaN(dt.getTime())) return String(iso).slice(0, 10);
  return dt.toLocaleString("es-AR", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === "className") node.className = String(v);
      else if (k === "text") node.textContent = String(v);
      else if (k.startsWith("on") && typeof v === "function") {
        node.addEventListener(k.slice(2).toLowerCase(), v);
      } else {
        node.setAttribute(k, v === true ? "" : String(v));
      }
    }
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    if (typeof child === "string" || typeof child === "number") {
      node.appendChild(document.createTextNode(String(child)));
    } else {
      node.appendChild(child);
    }
  }
  return node;
}
