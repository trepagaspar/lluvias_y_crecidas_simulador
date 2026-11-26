#!/usr/bin/env python3
"""
Sincroniza assets/*.json (osm_lines.json, city_pumps.json)
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


def _clip_segment_01(u0: float, v0: float, u1: float, v1: float):
    """Recorte Liang-Barsky de un segmento al dominio [0.0, 1.0] x [0.0, 1.0]."""
    du, dv = u1 - u0, v1 - v0
    t0, t1 = 0.0, 1.0
    for p, q in ((-du, u0), (du, 1.0 - u0), (-dv, v0), (dv, 1.0 - v0)):
        if abs(p) < 1e-12:
            if q < 0.0:
                return None
        else:
            r = q / p
            if p < 0.0:
                if r > t1:
                    return None
                if r > t0:
                    t0 = r
            else:
                if r < t0:
                    return None
                if r < t1:
                    t1 = r
    return (
        max(0.0, min(1.0, u0 + t0 * du)),
        max(0.0, min(1.0, v0 + t0 * dv)),
        max(0.0, min(1.0, u0 + t1 * du)),
        max(0.0, min(1.0, v0 + t1 * dv)),
    )


def clip_polyline_uv(pts):
    """Recorta una polilinea al rectangulo [0, 1]^2 preservando la cadena principal más larga."""
    chains = []
    cur = []
    for (u0, v0), (u1, v1) in zip(pts[:-1], pts[1:]):
        seg = _clip_segment_01(u0, v0, u1, v1)
        if seg is None:
            if len(cur) >= 2:
                chains.append(cur)
            cur = []
            continue
        cu0, cv0, cu1, cv1 = seg
        if not cur:
            cur = [(cu0, cv0), (cu1, cv1)]
        else:
            if math.hypot(cur[-1][0] - cu0, cur[-1][1] - cv0) > 1e-6:
                if len(cur) >= 2:
                    chains.append(cur)
                cur = [(cu0, cv0), (cu1, cv1)]
            else:
                cur.append((cu1, cv1))
    if len(cur) >= 2:
        chains.append(cur)
    if not chains:
        return []
    return max(chains, key=len)


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
    # 1. Canales y defensas OSM
    ln_path = ROOT / "datos" / "vectores" / "osm_canales_defensas.geojson"
    ln_fc = json.loads(ln_path.read_text(encoding="utf-8"))
    ln_out = []
    for feat in ln_fc.get("features", []):
        props = feat.get("properties") or {}
        coords = feat["geometry"]["coordinates"]
        uv = [((lon - LON_MIN) / (LON_MAX - LON_MIN), (LAT_MAX - lat) / (LAT_MAX - LAT_MIN)) for lon, lat in coords]
        clipped = clip_polyline_uv(uv)
        if len(clipped) < 2:
            continue
        simp = simplify_uv(clipped, tol=0.00028)
        ln_out.append({
            "t": "d" if props.get("tipo") == "defensa" else "c",
            "n": str(props.get("nombre") or ""),
            "p": [[round(u, 5), round(v, 5)] for u, v in simp],
        })
    (ASSETS / "osm_lines.json").write_text(
        json.dumps(ln_out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8"
    )

    # 2. Estaciones de bombeo
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

    print(f"Sincronizados assets/*.json: {len(ln_out)} trazas, {len(pm_out)} bombeos")
    return ln_out, pm_out


if __name__ == "__main__":
    sync_all()
