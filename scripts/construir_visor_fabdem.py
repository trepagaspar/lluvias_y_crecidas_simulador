#!/usr/bin/env python3
r"""
Reconstruye y valida todas las capas embebidas de visor_3d_santa_fe.html y GeoJSONs locales a partir de:
  1) datos/dem/fabdem_santa_fe.tif -> MDE suelo desnudo (~30 m, sin edificios/arboles ni saltos de hoja)
     - Actualiza DEM_SRC (520x429, 16-bit en canales R,G)
     - Calcula llenado hidrologico Priority-Flood + acumulacion de flujo D8 continua (con quemado suave de canales OSM)
     - Guarda datos/dem/acumulacion_flujo_fabdem.tif y datos/dem/flujo_binario_fabdem.tif
     - Actualiza ACUM_SRC (1040x857: R,G = log10 acumulacion continua sin costura en lat -31.6666; B = hillshade multidireccional)
     - Actualiza LAYERS_SRC (1040x857: limpia artefacto de agua sobre barranca de Entre Rios en canal G y actualiza corredores B)
  2) datos/vectores/osm_equipamiento_critico.geojson -> filtra Entre Rios, traduce nombres s/n y agrega cota_fabdem_m + barrio_cercano
  3) datos/vectores/osm_canales_defensas.geojson     -> filtra Entre Rios y agrega longitud_m + cota_media_fabdem_m
  4) datos/vectores/estaciones_bombeo_aprox.geojson  -> agrega cota_fabdem_m, u, v

Ejecutar con Python de QGIS:
  & "C:\Program Files\QGIS 3.40.13\bin\python-qgis-ltr.bat" scripts/construir_visor_fabdem.py
"""

import base64
import heapq
import io
import json
import math
import re
from pathlib import Path

import numpy as np
from osgeo import gdal, osr
from PIL import Image, ImageDraw

gdal.UseExceptions()

ROOT = Path(__file__).resolve().parent.parent
CONFIG_PATH = ROOT / "config" / "region_santa_fe.json"
HTML_PATH = ROOT / "visor_3d_santa_fe.html"
FABDEM_PATH = ROOT / "datos" / "dem" / "fabdem_santa_fe.tif"
OUT_ACUM_TIF = ROOT / "datos" / "dem" / "acumulacion_flujo_fabdem.tif"
OUT_BIN_TIF = ROOT / "datos" / "dem" / "flujo_binario_fabdem.tif"
OSM_EQUIP_PATH = ROOT / "datos" / "vectores" / "osm_equipamiento_critico.geojson"
OSM_LINES_PATH = ROOT / "datos" / "vectores" / "osm_canales_defensas.geojson"
PUMPS_PATH = ROOT / "datos" / "vectores" / "estaciones_bombeo_aprox.geojson"

_CFG = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
_BB = _CFG["bbox"]
_GR = _CFG["grid"]
_ER = _CFG["entre_rios_filter"]

LON_MIN, LON_MAX = float(_BB["lon_min"]), float(_BB["lon_max"])
LAT_MIN, LAT_MAX = float(_BB["lat_min"]), float(_BB["lat_max"])
DEM_MIN, DEM_MAX = float(_GR["dem_min_m"]), float(_GR["dem_max_m"])
MW, MH = int(_GR["mw"]), int(_GR["mh"])
W, H = int(_GR["w"]), int(_GR["h"])

import sys
sys.path.insert(0, str(Path(__file__).resolve().parent))
from descargar_osm import format_facility_name, is_entre_rios, nearest_barrio


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
    return np.where(np.isfinite(arr), arr, 12.0)


def sample_dem_grid(dem_hi: np.ndarray, lon: float, lat: float) -> float:
    u = np.clip((lon - LON_MIN) / (LON_MAX - LON_MIN), 0.0, 1.0)
    v = np.clip((LAT_MAX - lat) / (LAT_MAX - LAT_MIN), 0.0, 1.0)
    c = int(round(u * (dem_hi.shape[1] - 1)))
    r = int(round(v * (dem_hi.shape[0] - 1)))
    return round(float(dem_hi[r, c]), 2)


def save_geotiff(path: Path, arr: np.ndarray, gdal_type):
    drv = gdal.GetDriverByName("GTiff")
    ds = drv.Create(
        str(path),
        arr.shape[1],
        arr.shape[0],
        1,
        gdal_type,
        options=["COMPRESS=DEFLATE", "PREDICTOR=2", "TILED=YES"],
    )
    ds.SetGeoTransform([
        LON_MIN,
        (LON_MAX - LON_MIN) / arr.shape[1],
        0.0,
        LAT_MAX,
        0.0,
        -(LAT_MAX - LAT_MIN) / arr.shape[0],
    ])
    srs = osr.SpatialReference()
    srs.ImportFromEPSG(4326)
    ds.SetProjection(srs.ExportToWkt())
    ds.GetRasterBand(1).WriteArray(arr)
    ds.FlushCache()
    ds = None


def curate_and_enrich_vectors(dem_hi: np.ndarray):
    # 1) Equipamiento critico OSM: filtrar Entre Rios, traducir s/n y enriquecer con cota FABDEM + barrio
    if OSM_EQUIP_PATH.exists():
        fc = json.loads(OSM_EQUIP_PATH.read_text(encoding="utf-8"))
        clean_feats = []
        seen = set()
        for feat in fc.get("features", []):
            lon, lat = feat["geometry"]["coordinates"]
            if is_entre_rios(lon, lat):
                continue
            props = feat.get("properties") or {}
            cat = props.get("categoria", "escuela")
            subtipo = props.get("subtipo", "school")
            street = (props.get("direccion") or "").strip()
            barrio = nearest_barrio(lon, lat)
            nombre = format_facility_name(props.get("nombre", ""), subtipo, street, barrio)
            key = (cat, round(lon, 4), round(lat, 4), nombre.lower())
            if key in seen:
                continue
            seen.add(key)
            props["nombre"] = nombre
            props["barrio_cercano"] = barrio
            props["cota_fabdem_m"] = sample_dem_grid(dem_hi, lon, lat)
            feat["properties"] = props
            clean_feats.append(feat)
        fc["features"] = clean_feats
        OSM_EQUIP_PATH.write_text(json.dumps(fc, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    # 2) Canales y defensas OSM: filtrar Entre Rios y enriquecer con longitud_m y cota_media_fabdem_m
    if OSM_LINES_PATH.exists():
        fc = json.loads(OSM_LINES_PATH.read_text(encoding="utf-8"))
        clean_lines = []
        for feat in fc.get("features", []):
            coords = feat["geometry"]["coordinates"]
            if all(is_entre_rios(lon, lat) for lon, lat in coords):
                continue
            props = feat.get("properties") or {}
            length_m = 0.0
            cotas = [sample_dem_grid(dem_hi, coords[0][0], coords[0][1])]
            for (x0, y0), (x1, y1) in zip(coords[:-1], coords[1:]):
                length_m += math.hypot((x1 - x0) * 94800.0, (y1 - y0) * 110880.0)
                cotas.append(sample_dem_grid(dem_hi, x1, y1))
            props["longitud_m"] = round(length_m, 1)
            props["cota_media_fabdem_m"] = round(sum(cotas) / len(cotas), 2)
            feat["properties"] = props
            clean_lines.append(feat)
        fc["features"] = clean_lines
        OSM_LINES_PATH.write_text(json.dumps(fc, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    # 3) Estaciones de bombeo: agregar cota_fabdem_m, u, v
    if PUMPS_PATH.exists():
        fc = json.loads(PUMPS_PATH.read_text(encoding="utf-8"))
        for feat in fc.get("features", []):
            lon, lat = feat["geometry"]["coordinates"]
            props = feat.get("properties") or {}
            props["u"] = round((lon - LON_MIN) / (LON_MAX - LON_MIN), 5)
            props["v"] = round((LAT_MAX - lat) / (LAT_MAX - LAT_MIN), 5)
            props["cota_fabdem_m"] = sample_dem_grid(dem_hi, lon, lat)
            feat["properties"] = props
        PUMPS_PATH.write_text(json.dumps(fc, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def compute_fabdem_flow(dem_hi: np.ndarray, ctx: np.ndarray, osm_lines_raw) -> tuple[np.ndarray, np.ndarray]:
    """
    Calcula llenado hidrologico Priority-Flood (Barnes 2014) + flujo D8 continuo
    sobre FABDEM 1040x857 con quemado suave (-0.35 m) de canales/zanjas OSM.
    Elimina la costura entre hojas IGN (filas 656-657) y extiende la red al sur.
    """
    c_im = Image.new("L", (W, H), 0)
    dr = ImageDraw.Draw(c_im)
    for feat in osm_lines_raw:
        if (feat.get("properties") or {}).get("tipo") == "canal_zanja":
            pts = [
                (
                    (lon - LON_MIN) / (LON_MAX - LON_MIN) * (W - 1),
                    (LAT_MAX - lat) / (LAT_MAX - LAT_MIN) * (H - 1),
                )
                for lon, lat in feat["geometry"]["coordinates"]
            ]
            if len(pts) >= 2:
                dr.line(pts, fill=255, width=2)
    dem_route = np.where(np.array(c_im) > 0, dem_hi.astype(np.float64) - 0.35, dem_hi.astype(np.float64))

    N = H * W
    dem_f = dem_route.ravel()
    ctx_f = ctx.ravel()
    visited = np.zeros(N, dtype=np.bool_)
    parent = np.full(N, -1, dtype=np.int32)
    order = np.empty(N, dtype=np.int32)
    ord_ptr = 0

    border = np.zeros((H, W), dtype=np.bool_)
    border[0, :] = border[-1, :] = border[:, 0] = border[:, -1] = True
    seeds = np.where((ctx_f == 1) | (ctx_f == 9) | border.ravel())[0]

    heap = []
    heappush = heapq.heappush
    heappop = heapq.heappop
    for idx in seeds:
        visited[idx] = True
        heappush(heap, (int(dem_f[idx] * 100000), int(idx)))

    vis = visited
    par = parent
    W_int = W
    N_int = N
    while heap:
        z_int, idx = heappop(heap)
        order[ord_ptr] = idx
        ord_ptr += 1
        c = idx % W_int
        if c > 0:
            for n in (idx - 1, idx - W_int - 1, idx + W_int - 1):
                if 0 <= n < N_int and not vis[n]:
                    vis[n] = True
                    par[n] = idx
                    dz = int(dem_f[n] * 100000)
                    heappush(heap, (dz if dz > z_int else z_int + 1, n))
        if c < W_int - 1:
            for n in (idx + 1, idx - W_int + 1, idx + W_int + 1):
                if 0 <= n < N_int and not vis[n]:
                    vis[n] = True
                    par[n] = idx
                    dz = int(dem_f[n] * 100000)
                    heappush(heap, (dz if dz > z_int else z_int + 1, n))
        for n in (idx - W_int, idx + W_int):
            if 0 <= n < N_int and not vis[n]:
                vis[n] = True
                par[n] = idx
                dz = int(dem_f[n] * 100000)
                heappush(heap, (dz if dz > z_int else z_int + 1, n))

    acc = np.ones(N, dtype=np.float32)
    for i in range(ord_ptr - 1, -1, -1):
        u = order[i]
        p = par[u]
        if p >= 0:
            acc[p] += acc[u]

    acc_2d = acc.reshape(H, W)
    # Escala log10 equivalente a grilla de 15 m (x4 celdas por area) y truncada a [0, 6.2]
    ac_log = np.where((ctx == 1) | (ctx == 9), 0.0, np.log10(np.maximum(1.0, acc_2d * 4.0)))
    ac_log = np.clip(ac_log, 0.0, 6.2).astype(np.float32)
    bin_flow = np.where((ac_log >= 3.52) & (ctx != 1) & (ctx != 2) & (ctx != 9) & (ctx != 10), 255, 0).astype(np.uint8)
    return ac_log, bin_flow


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
        d = math.hypot(px - x0, py - y0) if denom < 1e-12 else abs(dy * px - dx * py + x1 * y0 - y1 * x0) / denom
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
        return [], []
    fc = json.loads(OSM_LINES_PATH.read_text(encoding="utf-8"))
    out = []
    raw_feats = fc.get("features", [])
    for feat in raw_feats:
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
    return out, raw_feats


def main():
    html = HTML_PATH.read_text(encoding="utf-8")

    # 1) FABDEM -> DEM_SRC (520x429) y grillas 1040x857
    dem_mesh = warp_fabdem(MW, MH)
    dem_hi = warp_fabdem(W, H)
    curate_and_enrich_vectors(dem_hi)
    osm_fac = load_osm_facilities()
    osm_lines, raw_line_feats = load_osm_lines()

    dem_b64 = encode_dem_png_b64(dem_mesh)
    html, n_dem = re.subn(
        r'const DEM_SRC = "data:image/png;base64,[^"]+";',
        f'const DEM_SRC = "data:image/png;base64,{dem_b64}";',
        html,
        count=1,
    )
    assert n_dem == 1

    # 2) LAYERS_SRC: limpiar barranca entrerriana (dem_hi > 16.5m en esquina SE) y actualizar flujo_binario_fabdem
    m_lay = re.search(r'const LAYERS_SRC = "data:image/png;base64,([^"]+)";', html)
    assert m_lay
    lay_arr = np.array(Image.open(io.BytesIO(base64.b64decode(m_lay.group(1)))).convert("RGBA"))
    se_cliff = (
        (dem_hi > float(_ER["cliff_dem_gt_m"]))
        & (np.arange(H)[:, None] > int(H * float(_ER["cliff_row_frac_gt"])))
        & (np.arange(W)[None, :] > int(W * float(_ER["cliff_col_frac_gt"])))
    )
    cleaned_cliff_px = int((se_cliff & ((lay_arr[..., 1] == 1) | (lay_arr[..., 1] == 2))).sum())
    lay_arr[..., 1] = np.where(se_cliff & ((lay_arr[..., 1] == 1) | (lay_arr[..., 1] == 2)), 0, lay_arr[..., 1])

    # 3) Calcular flujo continuo Priority-Flood + D8 sobre FABDEM
    ac_log, bin_flow = compute_fabdem_flow(dem_hi, lay_arr[..., 1], raw_line_feats)
    save_geotiff(OUT_ACUM_TIF, ac_log, gdal.GDT_Float32)
    save_geotiff(OUT_BIN_TIF, bin_flow, gdal.GDT_Byte)

    lay_arr[..., 2] = bin_flow
    buf_lay = io.BytesIO()
    Image.fromarray(lay_arr, mode="RGBA").save(buf_lay, format="PNG", optimize=True)
    lay_b64 = base64.b64encode(buf_lay.getvalue()).decode("ascii")
    html, n_lay = re.subn(
        r'const LAYERS_SRC = "data:image/png;base64,[^"]+";',
        f'const LAYERS_SRC = "data:image/png;base64,{lay_b64}";',
        html,
        count=1,
    )
    assert n_lay == 1

    # 4) ACUM_SRC: R,G = ac_log continuo (16-bit / 6.5) + B = hillshade multidireccional FABDEM
    hs_u8 = compute_hillshade(dem_hi)
    ac_u16 = np.round(np.clip(ac_log / 6.5, 0.0, 1.0) * 65535.0).astype(np.uint16)
    acum_arr = np.zeros((H, W, 4), dtype=np.uint8)
    acum_arr[..., 0] = (ac_u16 >> 8).astype(np.uint8)
    acum_arr[..., 1] = (ac_u16 & 0xFF).astype(np.uint8)
    acum_arr[..., 2] = hs_u8
    acum_arr[..., 3] = 255
    buf_acu = io.BytesIO()
    Image.fromarray(acum_arr, mode="RGBA").save(buf_acu, format="PNG", optimize=True)
    acum_b64 = base64.b64encode(buf_acu.getvalue()).decode("ascii")
    html, n_acum = re.subn(
        r'const ACUM_SRC = "data:image/png;base64,[^"]+";',
        f'const ACUM_SRC = "data:image/png;base64,{acum_b64}";',
        html,
        count=1,
    )
    assert n_acum == 1

    # 5) OSM facilities + lines
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
    assert n_osm == 1

    HTML_PATH.write_text(html, encoding="utf-8")
    print(f"FABDEM DEM_SRC: {MW}x{MH}, min={dem_mesh.min():.2f}m, med={np.median(dem_mesh):.2f}m, max={dem_mesh.max():.2f}m ({len(dem_b64)//1024} KB)")
    print(f"FABDEM Flujo D8 continuo: p50={np.median(ac_log):.2f}, p95={np.percentile(ac_log,95):.2f}, max={ac_log.max():.2f} | binFlow={int((bin_flow>0).sum())} px (limpiados {cleaned_cliff_px} px barranca ER)")
    print(f"FABDEM ACUM_SRC + Hillshade: {W}x{H} ({len(acum_b64)//1024} KB)")
    print(f"OSM curado (Gran Santa Fe): {len(osm_fac)} puntos criticos, {len(osm_lines)} trazas canales/defensas")
    print(f"Escrito {HTML_PATH} ({HTML_PATH.stat().st_size / (1024*1024):.2f} MB)")


if __name__ == "__main__":
    main()
