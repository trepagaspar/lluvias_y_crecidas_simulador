#!/usr/bin/env python3
"""
Sincroniza assets/*.json (osm_facilities.json, osm_lines.json, city_pumps.json)
desde los GeoJSON autoritativos de datos/vectores/ usando solo la biblioteca estandar de Python.
Puede ejecutarse en CI sin dependencias de QGIS/GDAL.
"""

import json
import math
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CFG = json.loads((ROOT / "config" / "region_santa_fe.json").read_text(encoding="utf-8"))
BB = CFG["bbox"]
LON_MIN, LON_MAX = float(BB["lon_min"]), float(BB["lon_max"])
LAT_MIN, LAT_MAX = float(BB["lat_min"]), float(BB["lat_max"])

ASSETS = ROOT / "assets"
ASSETS.mkdir(exist_ok=True)


def simplify_uv(pts, tol: float = 0.00028):
    if len(pts) <= 2:
        return pts
    x0, y0 = pts[0]
    x1, y1 = pts[-1]
    dx, dy = x1 - x0, y1 - y0
    denom = math.hypot(dx, dy)
    max_d, idx = -1.0, 0
    for i in range(1, len(pts) - 1):
        px, py = pts[i]
        d = math.hypot(px - x0, py - y0) if denom < 1e-12 else abs(dy * px - dx * py + x1 * y0 - y1 * x0) / denom
        if d > max_d:
            max_d, idx = d, i
    if max_d > tol:
        left = simplify_uv(pts[: idx + 1], tol)
        right = simplify_uv(pts[idx:], tol)
        return left[:-1] + right
    return [pts[0], pts[-1]]


def sync_all():
    # 1. Equipamiento critico OSM
    eq_path = ROOT / "datos" / "vectores" / "osm_equipamiento_critico.geojson"
    eq_fc = json.loads(eq_path.read_text(encoding="utf-8"))
    cat_map = {"salud": "s", "escuela": "e", "emergencia": "x"}
    fac_out = []
    for feat in eq_fc.get("features", []):
        props = feat.get("properties") or {}
        lon, lat = feat["geometry"]["coordinates"]
        u = (lon - LON_MIN) / (LON_MAX - LON_MIN)
        v = (LAT_MAX - lat) / (LAT_MAX - LAT_MIN)
        if not (0.0 <= u <= 1.0 and 0.0 <= v <= 1.0):
            continue
        nombre = str(props.get("nombre") or "").strip()
        if len(nombre) > 64:
            nombre = nombre[:61] + "..."
        fac_out.append({
            "t": cat_map.get(props.get("categoria"), "e"),
            "n": nombre,
            "u": round(u, 5),
            "v": round(v, 5),
            "b": str(props.get("barrio_cercano") or ""),
            "z": props.get("cota_fabdem_m"),
        })
    (ASSETS / "osm_facilities.json").write_text(
        json.dumps(fac_out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8"
    )

    # 2. Canales y defensas OSM
    ln_path = ROOT / "datos" / "vectores" / "osm_canales_defensas.geojson"
    ln_fc = json.loads(ln_path.read_text(encoding="utf-8"))
    ln_out = []
    for feat in ln_fc.get("features", []):
        props = feat.get("properties") or {}
        coords = feat["geometry"]["coordinates"]
        uv = [((lon - LON_MIN) / (LON_MAX - LON_MIN), (LAT_MAX - lat) / (LAT_MAX - LAT_MIN)) for lon, lat in coords]
        if not any(0.0 <= u <= 1.0 and 0.0 <= v <= 1.0 for u, v in uv):
            continue
        simp = simplify_uv(uv, tol=0.00028)
        ln_out.append({
            "t": "d" if props.get("tipo") == "defensa" else "c",
            "n": str(props.get("nombre") or ""),
            "p": [[round(u, 5), round(v, 5)] for u, v in simp],
        })
    (ASSETS / "osm_lines.json").write_text(
        json.dumps(ln_out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8"
    )

    # 3. Estaciones de bombeo
    pm_path = ROOT / "datos" / "vectores" / "estaciones_bombeo_aprox.geojson"
    pm_fc = json.loads(pm_path.read_text(encoding="utf-8"))
    pm_out = []
    for feat in pm_fc.get("features", []):
        props = feat.get("properties") or {}
        lon, lat = feat["geometry"]["coordinates"]
        u = props.get("u") if props.get("u") is not None else (lon - LON_MIN) / (LON_MAX - LON_MIN)
        v = props.get("v") if props.get("v") is not None else (LAT_MAX - lat) / (LAT_MAX - LAT_MIN)
        pm_out.append({
            "id": int(props["id"]),
            "u": round(float(u), 5),
            "v": round(float(v), 5),
            "s": str(props.get("sector") or ""),
            "z": props.get("cota_fabdem_m"),
        })
    (ASSETS / "city_pumps.json").write_text(
        json.dumps(pm_out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8"
    )

    print(f"Sincronizados assets/*.json: {len(fac_out)} equipamientos, {len(ln_out)} trazas, {len(pm_out)} bombeos")
    return fac_out, ln_out, pm_out


if __name__ == "__main__":
    sync_all()
