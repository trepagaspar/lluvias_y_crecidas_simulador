#!/usr/bin/env python3
"""
Genera dist/visor_offline.html: version autocontenida 100% portable para abrir con file://
sin servidor web, empaquetando index.html + src/ + config/region_santa_fe.json + assets/ + datos_en_vivo.json.
Solo usa la biblioteca estandar de Python.
"""

import base64
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DIST = ROOT / "dist"
DIST.mkdir(exist_ok=True)

MODULE_ORDER = [
    "icons.js",
    "format.js",
    "live-data.js",
    "sim-engine.js",
    "story.js",
    "webgl-renderer.js",
    "ui.js",
    "main.js",
]


def strip_esm(code: str) -> str:
    # Elimina imports entre modulos locales y prefijos export para ejecutar dentro de un IIFE unico
    out_lines = []
    for line in code.splitlines():
        if re.match(r"^\s*import\s+.*from\s+[\"']\./[^\"']+[\"'];?\s*$", line):
            continue
        line = re.sub(r"^(\s*)export\s+(?=(?:async\s+)?(?:function|const|let|var|class)\b)", r"\1", line)
        out_lines.append(line)
    return "\n".join(out_lines)


def png_b64(path: Path) -> str:
    return "data:image/png;base64," + base64.b64encode(path.read_bytes()).decode("ascii")


def main():
    html = (ROOT / "index.html").read_text(encoding="utf-8")
    css = (ROOT / "src" / "styles.css").read_text(encoding="utf-8")

    bundle = {
        "regionCfg": json.loads((ROOT / "config" / "region_santa_fe.json").read_text(encoding="utf-8")),
        "cityPumps": json.loads((ROOT / "assets" / "city_pumps.json").read_text(encoding="utf-8")),
        "osmFacilities": json.loads((ROOT / "assets" / "osm_facilities.json").read_text(encoding="utf-8")),
        "osmLines": json.loads((ROOT / "assets" / "osm_lines.json").read_text(encoding="utf-8")),
        "liveCache": json.loads((ROOT / "datos_en_vivo.json").read_text(encoding="utf-8"))
        if (ROOT / "datos_en_vivo.json").exists()
        else None,
        "demSrc": png_b64(ROOT / "assets" / "dem.png"),
        "layersSrc": png_b64(ROOT / "assets" / "layers.png"),
        "acumSrc": png_b64(ROOT / "assets" / "acum.png"),
    }

    js_parts = [f"window.__OFFLINE_BUNDLE__ = {json.dumps(bundle, ensure_ascii=False, separators=(',', ':'))};", "(() => {"]
    for mod in MODULE_ORDER:
        src = (ROOT / "src" / mod).read_text(encoding="utf-8")
        js_parts.append(f"// --- {mod} ---")
        js_parts.append(strip_esm(src))
    js_parts.append("})();")
    bundled_js = "\n".join(js_parts)

    html = html.replace('<link rel="stylesheet" href="./src/styles.css">', f"<style>\n{css}\n</style>")
    html = html.replace(
        '<script type="module" src="./src/main.js"></script>',
        f"<script>\n{bundled_js}\n</script>",
    )

    out_path = DIST / "visor_offline.html"
    out_path.write_text(html, encoding="utf-8")
    print(f"Generado {out_path} ({out_path.stat().st_size / (1024 * 1024):.2f} MB)")


if __name__ == "__main__":
    main()
