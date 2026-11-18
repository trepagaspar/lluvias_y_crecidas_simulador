#!/usr/bin/env python3
r"""
Reconstruye las capas embebidas de visor_3d_santa_fe.html a partir de:
  1) datos/dem/fabdem_santa_fe.tif   -> MDE suelo desnudo (30 m, sin edificios/arboles ni saltos de hoja)
     - Actualiza DEM_SRC (520x429, 16-bit en canales R,G)
     - Recalcula el sombreado (hillshade) en el canal B de ACUM_SRC (1040x857), preservando R,G
  2) datos/vectores/osm_equipamiento_critico.geojson -> OSM_FACILITIES (salud, escuelas, emergencia)
  3) datos/vectores/osm_canales_defensas.geojson     -> OSM_LINES (canales/zanjas y defensas/terraplenes)

Ejecutar con Python de QGIS (que incluye GDAL, NumPy y Pillow):
  & "C:\Program Files\QGIS 3.40.13\bin\python-qgis-ltr.bat" scripts/construir_visor_fabdem.py
"""

import base64
import io
import json
import math
import re
from pathlib import Path

import numpy as np
from osgeo import gdal
from PIL import Image

gdal.UseExceptions()

ROOT = Path(__file__).resolve().parent.parent
HTML_PATH = ROOT / "visor_3d_santa_fe.html"
FABDEM_PATH = ROOT / "datos" / "dem" / "fabdem_santa_fe.tif"
OSM_EQUIP_PATH = ROOT / "datos" / "vectores" / "osm_equipamiento_critico.geojson"
OSM_LINES_PATH = ROOT / "datos" / "vectores" / "osm_canales_defensas.geojson"

LON_MIN, LON_MAX = -60.82009781, -60.53982345
LAT_MIN, LAT_MAX = -31.72049460, -31.48953774
DEM_MIN, DEM_MAX = -10.0, 75.0
MW, MH = 520, 429
W, H = 1040, 857


def warp_fabdem(width: int, height: int) -> np.ndarray:
    ds = gdal.Warp(
        "",
        str(FABDEM_PATH),
        format="MEM",
        outputBounds=[LON_MIN, LAT_MIN, LON_MAX, LAT_MAX],
        width=width,
        height=height,
        resampleAlg=gdal.GRA_Bilinear,
    )
    arr = ds.ReadAsArray().astype(np.float32)
    arr = np.where(np.isfinite(arr), arr, 12.0)
    return arr


def encode_dem_png_b64(dem: np.ndarray) -> str:
    norm = np.clip((dem - DEM_MIN) / (DEM_MAX - DEM_MIN), 0.0, 1.0)
    u16 = np.round(norm * 65535.0).astype(np.uint16)
    rgba = np.zeros((dem.shape[0], dem.shape[1], 4), dtype=np.uint8)
    rgba[..., 0] = (u16 >> 8).astype(np.uint8)
    rgba[..., 1] = (u16 & 0xFF).astype(np.uint8)
    rgba[..., 3] = 255
    buf = io.BytesIO()
    Image.fromarray(rgba, mode="RGBA").save(buf, format="PNG", optimize=True)
    return base64.b64encode(buf.getvalue()).decode("ascii")


def compute_hillshade(dem_hi: np.ndarray) -> np.ndarray:
    # Espaciado metrico real para latitud -31.6 grados
    dx = 26500.0 / dem_hi.shape[1]
    dy = 25700.0 / dem_hi.shape[0]
    z_factor = 14.0
    dz_dy, dz_dx = np.gradient(dem_hi * z_factor, dy, dx)
    slope = np.arctan(np.hypot(dz_dx, dz_dy))
    aspect = np.arctan2(-dz_dx, dz_dy)

    def single_hs(az_deg: float, alt_deg: float) -> np.ndarray:
        az = math.radians(az_deg)
        zen = math.radians(90.0 - alt_deg)
        hs = np.cos(zen) * np.cos(slope) + np.sin(zen) * np.sin(slope) * np.cos(az - aspect)
        return np.clip(hs, 0.0, 1.0)

    # Iluminacion multidireccional suave (NW principal + NNE relleno)
    hs = 0.72 * single_hs(315.0, 42.0) + 0.28 * single_hs(25.0, 50.0)
    return np.round(np.clip(hs, 0.0, 1.0) * 255.0).astype(np.uint8)


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
        if denom < 1e-12:
            d = math.hypot(px - x0, py - y0)
        else:
            d = abs(dy * px - dx * py + x1 * y0 - y1 * x0) / denom
        if d > max_d:
            max_d, idx = d, i
    if max_d > tol:
        left = simplify_uv(pts[: idx + 1], tol)
        right = simplify_uv(pts[idx:], tol)
        return left[:-1] + right
    return [pts[0], pts[-1]]


def load_osm_facilities():
    if not OSM_EQUIP_PATH.exists():
        return []
    fc = json.loads(OSM_EQUIP_PATH.read_text(encoding="utf-8"))
    out = []
    cat_map = {"salud": "s", "escuela": "e", "emergencia": "x"}
    for feat in fc.get("features", []):
        props = feat.get("properties") or {}
        lon, lat = feat["geometry"]["coordinates"]
        u = (lon - LON_MIN) / (LON_MAX - LON_MIN)
        v = (LAT_MAX - lat) / (LAT_MAX - LAT_MIN)
        if not (0.0 <= u <= 1.0 and 0.0 <= v <= 1.0):
            continue
        nombre = str(props.get("nombre") or "").strip()
        if len(nombre) > 64:
            nombre = nombre[:61] + "..."
        out.append({
            "t": cat_map.get(props.get("categoria"), "e"),
            "n": nombre,
            "u": round(u, 5),
            "v": round(v, 5),
        })
    return out


def load_osm_lines():
    if not OSM_LINES_PATH.exists():
        return []
    fc = json.loads(OSM_LINES_PATH.read_text(encoding="utf-8"))
    out = []
    for feat in fc.get("features", []):
        props = feat.get("properties") or {}
        coords = feat["geometry"]["coordinates"]
        uv = [
            (
                (lon - LON_MIN) / (LON_MAX - LON_MIN),
                (LAT_MAX - lat) / (LAT_MAX - LAT_MIN),
            )
            for lon, lat in coords
        ]
        if not any(0.0 <= u <= 1.0 and 0.0 <= v <= 1.0 for u, v in uv):
            continue
        simp = simplify_uv(uv, tol=0.00028)
        pts = [[round(u, 5), round(v, 5)] for u, v in simp]
        out.append({
            "t": "d" if props.get("tipo") == "defensa" else "c",
            "p": pts,
        })
    return out


def main():
    html = HTML_PATH.read_text(encoding="utf-8")

    # 1) FABDEM -> DEM_SRC (520x429)
    dem_mesh = warp_fabdem(MW, MH)
    dem_b64 = encode_dem_png_b64(dem_mesh)
    html, n_dem = re.subn(
        r'const DEM_SRC = "data:image/png;base64,[^"]+";',
        f'const DEM_SRC = "data:image/png;base64,{dem_b64}";',
        html,
        count=1,
    )
    assert n_dem == 1, "No se encontro DEM_SRC en visor_3d_santa_fe.html"

    # 2) FABDEM -> hillshade en canal B de ACUM_SRC (1040x857)
    dem_hi = warp_fabdem(W, H)
    hs_u8 = compute_hillshade(dem_hi)
    m_acum = re.search(r'const ACUM_SRC = "data:image/png;base64,([^"]+)";', html)
    assert m_acum, "No se encontro ACUM_SRC en visor_3d_santa_fe.html"
    acum_img = Image.open(io.BytesIO(base64.b64decode(m_acum.group(1)))).convert("RGBA")
    acum_arr = np.array(acum_img)
    assert acum_arr.shape[:2] == (H, W), f"Tamano inesperado ACUM_SRC: {acum_arr.shape}"
    acum_arr[..., 2] = hs_u8
    buf = io.BytesIO()
    Image.fromarray(acum_arr, mode="RGBA").save(buf, format="PNG", optimize=True)
    acum_b64 = base64.b64encode(buf.getvalue()).decode("ascii")
    html, n_acum = re.subn(
        r'const ACUM_SRC = "data:image/png;base64,[^"]+";',
        f'const ACUM_SRC = "data:image/png;base64,{acum_b64}";',
        html,
        count=1,
    )
    assert n_acum == 1

    # 3) OSM facilities + lines
    osm_fac = load_osm_facilities()
    osm_lines = load_osm_lines()
    osm_block = (
        "/*__OSM_START__*/\n"
        f"  const OSM_FACILITIES = {json.dumps(osm_fac, ensure_ascii=False, separators=(',', ':'))};\n"
        f"  const OSM_LINES = {json.dumps(osm_lines, ensure_ascii=False, separators=(',', ':'))};\n"
        "  /*__OSM_END__*/"
    )
    html, n_osm = re.subn(
        r"/\*__OSM_START__\*/.*?/\*__OSM_END__\*/",
        lambda _: osm_block,
        html,
        count=1,
        flags=re.S,
    )
    assert n_osm == 1, "No se encontraron marcadores __OSM_START__/__OSM_END__"

    HTML_PATH.write_text(html, encoding="utf-8")
    print(f"FABDEM DEM_SRC: {MW}x{MH}, min={dem_mesh.min():.2f}m, med={np.median(dem_mesh):.2f}m, max={dem_mesh.max():.2f}m (PNG b64: {len(dem_b64)//1024} KB)")
    print(f"FABDEM Hillshade en ACUM_SRC: {W}x{H}, p05={np.percentile(hs_u8,5):.0f}, p50={np.median(hs_u8):.0f}, p95={np.percentile(hs_u8,95):.0f} (PNG b64: {len(acum_b64)//1024} KB)")
    print(f"OSM embebido: {len(osm_fac)} puntos criticos, {len(osm_lines)} trazas canales/defensas")
    print(f"Escrito {HTML_PATH} ({HTML_PATH.stat().st_size / (1024*1024):.2f} MB)")


if __name__ == "__main__":
    main()
