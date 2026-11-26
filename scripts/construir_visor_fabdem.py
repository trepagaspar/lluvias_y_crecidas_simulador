#!/usr/bin/env python3
r"""
Reconstruye de forma 100% reproducible todos los assets del visor 3D (assets/*.png y assets/*.json)
y enriquece los GeoJSON locales directamente desde los archivos fuente (sin lectura circular del HTML):
  1) datos/dem/fabdem_santa_fe.tif -> assets/dem.png (520x429, 16-bit R,G)
  2) Vectores fuente en datos/vectores/ -> assets/layers.png (1040x857):
     - R: riesgo hidrico (riesgo hidrico - Santa Fe ciudad.gpkg)
     - G: contexto (BH140 aguas continentales, AL170 parques, relleno sanitario/AB000, reservorios_santa_fe.geojson)
     - B: flujo binario Priority-Flood + D8 continuo sobre FABDEM (con quemado de canales OSM)
  3) Priority-Flood + D8 + hillshade multidireccional -> assets/acum.png (1040x857)
     + datos/dem/acumulacion_flujo_fabdem.tif y datos/dem/flujo_binario_fabdem.tif
  4) Curacion y enriquecimiento FABDEM de osm_canales_defensas.geojson
     y estaciones_bombeo_aprox.geojson -> sync a assets/*.json

Ejecutar con Python de QGIS (Windows) o Python con GDAL/NumPy/Pillow (Linux):
  & "C:\Program Files\QGIS 3.40.13\bin\python-qgis-ltr.bat" scripts/construir_visor_fabdem.py
"""

import collections
import heapq
import json
import math
import sys
from pathlib import Path

import numpy as np
from osgeo import gdal, ogr, osr
from PIL import Image, ImageDraw

gdal.UseExceptions()
ogr.UseExceptions()

ROOT = Path(__file__).resolve().parent.parent
CONFIG_PATH = ROOT / "config" / "region_santa_fe.json"
ASSETS_DIR = ROOT / "assets"
ASSETS_DIR.mkdir(exist_ok=True)

FABDEM_PATH = ROOT / "datos" / "dem" / "fabdem_santa_fe.tif"
OUT_ACUM_TIF = ROOT / "datos" / "dem" / "acumulacion_flujo_fabdem.tif"
OUT_BIN_TIF = ROOT / "datos" / "dem" / "flujo_binario_fabdem.tif"

VEC_DIR = ROOT / "datos" / "vectores"
RIESGO_GPKG = VEC_DIR / "riesgo hidrico - Santa Fe ciudad.gpkg"
AGUAS_GJ = VEC_DIR / "cuerpos_agua_santa_fe.geojson"
PARQUES_SHP = VEC_DIR / "areas_de_equipamiento_AL170Polygon.shp"
RELLENO_SHP = VEC_DIR / "areas_de_gestion_de_residuos_relleno_sanitarioPolygon.shp"
RESIDUOS_SHP = VEC_DIR / "areas_de_gestion_de_residuos_AB000Polygon.shp"
RESERVORIOS_GJ = VEC_DIR / "reservorios_santa_fe.geojson"

OSM_LINES_PATH = VEC_DIR / "osm_canales_defensas.geojson"
PUMPS_PATH = VEC_DIR / "estaciones_bombeo_aprox.geojson"

_CFG = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
_BB = _CFG["bbox"]
_GR = _CFG["grid"]
_ER = _CFG["entre_rios_filter"]

LON_MIN, LON_MAX = float(_BB["lon_min"]), float(_BB["lon_max"])
LAT_MIN, LAT_MAX = float(_BB["lat_min"]), float(_BB["lat_max"])
DEM_MIN, DEM_MAX = float(_GR["dem_min_m"]), float(_GR["dem_max_m"])
MW, MH = int(_GR["mw"]), int(_GR["mh"])
W, H = int(_GR["w"]), int(_GR["h"])

sys.path.insert(0, str(Path(__file__).resolve().parent))
from descargar_osm import compute_line_length_m, is_entre_rios
from sync_assets_json import simplify_uv, sync_all


def despike_santa_fe_dem(arr: np.ndarray) -> np.ndarray:
    """Filtra picos anómalos (antenas, silos, ruido radar > 23,5 m) en la llanura santafesina sin tocar la barranca SE."""
    h, w = arr.shape
    rr, cc = np.indices((h, w))
    se_er = (rr > int(h * float(_ER["cliff_row_frac_gt"]))) & (cc > int(w * float(_ER["cliff_col_frac_gt"])))
    out = arr.copy()
    for _ in range(2):
        padded = np.pad(out, 3, mode="edge")
        win = np.lib.stride_tricks.sliding_window_view(padded, (7, 7))
        med = np.median(win, axis=(-2, -1)).astype(np.float32)
        bad = (~se_er) & ((out > 23.5) | ((out - med) > 2.2))
        if not np.any(bad):
            break
        out = np.where(bad, np.minimum(med, 23.0), out)
    # Tope de seguridad sobre clusters aislados en margen santafesina (llanura real <= 23,5 m)
    out = np.where((~se_er) & (out > 23.8), 23.0, out)
    return out.astype(np.float32)


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
    return despike_santa_fe_dem(arr)


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


def _make_mem_raster(width: int, height: int, init_val: int = 0):
    drv = gdal.GetDriverByName("MEM")
    ds = drv.Create("", width, height, 1, gdal.GDT_Byte)
    ds.SetGeoTransform([
        LON_MIN,
        (LON_MAX - LON_MIN) / width,
        0.0,
        LAT_MAX,
        0.0,
        -(LAT_MAX - LAT_MIN) / height,
    ])
    srs = osr.SpatialReference()
    srs.ImportFromEPSG(4326)
    ds.SetProjection(srs.ExportToWkt())
    ds.GetRasterBand(1).Fill(init_val)
    return ds


def _rasterize_vector(path: Path, burn_val: int = 1, where: str | None = None) -> np.ndarray:
    if not path.exists():
        return np.zeros((H, W), dtype=np.uint8)
    vec = ogr.Open(str(path))
    if vec is None:
        return np.zeros((H, W), dtype=np.uint8)
    lyr = vec.GetLayer(0)
    if where:
        lyr.SetAttributeFilter(where)
    ds = _make_mem_raster(W, H, 0)
    gdal.RasterizeLayer(ds, [1], lyr, burn_values=[burn_val])
    return ds.ReadAsArray().astype(np.uint8)


def _inner_edge(mask: np.ndarray) -> np.ndarray:
    """Detecta borde interno de 1 px (4-conectividad) para estilos relleno/borde en ctxId."""
    m = mask.astype(bool)
    up = np.pad(m[:-1, :], ((1, 0), (0, 0)), constant_values=False)
    dn = np.pad(m[1:, :], ((0, 1), (0, 0)), constant_values=False)
    lt = np.pad(m[:, :-1], ((0, 0), (1, 0)), constant_values=False)
    rt = np.pad(m[:, 1:], ((0, 0), (0, 1)), constant_values=False)
    interior = m & up & dn & lt & rt
    return m & (~interior)


def rasterize_layers_from_vectors(dem_hi: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Genera canales R (riskId) y G (ctxId) de assets/layers.png directamente desde vectores fuente."""
    # R: riesgo hidrico (1=IV, 2=III, 3=II/III, 4=II, 5=I)
    risk = np.zeros((H, W), dtype=np.uint8)
    if RIESGO_GPKG.exists():
        vec = ogr.Open(str(RIESGO_GPKG))
        lyr = vec.GetLayer(0)
        zone_map = [("IV", 1), ("III", 2), ("II/III", 3), ("II", 4), ("I", 5)]
        for z_name, z_code in zone_map:
            lyr.SetAttributeFilter(f"zonafinal = '{z_name}'")
            ds = _make_mem_raster(W, H, 0)
            gdal.RasterizeLayer(ds, [1], lyr, burn_values=[z_code])
            arr = ds.ReadAsArray()
            risk = np.where(arr > 0, z_code, risk).astype(np.uint8)
        lyr.SetAttributeFilter(None)

    # G: contexto (1/2 Parana, 3/4 Parques, 5/6 Relleno, 7/8 Reservorios, 9/10 Salado)
    ctx = np.zeros((H, W), dtype=np.uint8)

    # Aguas continentales (Parana/Setubal y Salado desde cuerpos_agua_santa_fe.geojson)
    parana_mask = _rasterize_vector(AGUAS_GJ, 1, "sistema = 'parana_setubal'") > 0
    salado_mask = _rasterize_vector(AGUAS_GJ, 1, "sistema = 'salado'") > 0

    se_cliff = (
        (dem_hi > float(_ER["cliff_dem_gt_m"]))
        & (np.arange(H)[:, None] > int(H * float(_ER["cliff_row_frac_gt"])))
        & (np.arange(W)[None, :] > int(W * float(_ER["cliff_col_frac_gt"])))
    )
    parana_mask = parana_mask & (~se_cliff)

    # Continuar cauces/lagunas conectados desde Laguna Setúbal hacia el NE (Arroyo Leyes/Ubajay) donde BH140 se cortaba recto en lon -60,62
    ne_col_min = int(W * 0.65)
    ne_row_max = int(H * 0.62)
    elig_ne = (~se_cliff) & (~salado_mask) & (risk != 1) & (dem_hi <= 11.25)
    elig_ne[:ne_row_max, ne_col_min:] |= (~se_cliff[:ne_row_max, ne_col_min:]) & (~salado_mask[:ne_row_max, ne_col_min:]) & (risk[:ne_row_max, ne_col_min:] != 1) & (dem_hi[:ne_row_max, ne_col_min:] <= 11.65)
    # Solo expandir desde el borde conectado de parana_mask (evita llenar depresiones aisladas)
    seed_pts = np.argwhere(parana_mask)
    q = collections.deque((int(r), int(c)) for r, c in seed_pts)
    while q:
        r, c = q.popleft()
        for nr, nc in ((r - 1, c), (r + 1, c), (r, c - 1), (r, c + 1)):
            if 0 <= nr < H and 0 <= nc < W and not parana_mask[nr, nc]:
                if (nr < ne_row_max and nc >= ne_col_min and elig_ne[nr, nc]) or (
                    not se_cliff[nr, nc] and not salado_mask[nr, nc] and risk[nr, nc] != 1 and dem_hi[nr, nc] <= 10.65
                ):
                    parana_mask[nr, nc] = True
                    q.append((nr, nc))

    ctx = np.where(parana_mask, np.where(_inner_edge(parana_mask), 2, 1), ctx)
    ctx = np.where(salado_mask, np.where(_inner_edge(salado_mask), 10, 9), ctx)

    parks_mask = _rasterize_vector(PARQUES_SHP, 1, "objeto = 'Espacio Verde'") > 0
    ctx = np.where(parks_mask, np.where(_inner_edge(parks_mask), 4, 3), ctx)

    landfill_mask = (_rasterize_vector(RELLENO_SHP, 1) > 0) | (_rasterize_vector(RESIDUOS_SHP, 1) > 0)
    ctx = np.where(landfill_mask, np.where(_inner_edge(landfill_mask), 6, 5), ctx)

    res_mask = _rasterize_vector(RESERVORIOS_GJ, 1) > 0
    ctx = np.where(res_mask, np.where(_inner_edge(res_mask), 8, 7), ctx)

    return risk.astype(np.uint8), ctx.astype(np.uint8)


def curate_and_enrich_vectors(dem_hi: np.ndarray):
    if OSM_LINES_PATH.exists():
        fc = json.loads(OSM_LINES_PATH.read_text(encoding="utf-8"))
        clean_lines = []
        for feat in fc.get("features", []):
            coords = feat["geometry"]["coordinates"]
            if all(is_entre_rios(lon, lat) for lon, lat in coords):
                continue
            props = feat.get("properties") or {}
            cotas = [sample_dem_grid(dem_hi, lon, lat) for lon, lat in coords]
            props["longitud_m"] = compute_line_length_m(coords)
            props["cota_media_fabdem_m"] = round(sum(cotas) / len(cotas), 2)
            feat["properties"] = props
            clean_lines.append(feat)
        fc["features"] = clean_lines
        OSM_LINES_PATH.write_text(json.dumps(fc, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

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
    """Llenado hidrologico Priority-Flood (Barnes 2014) + flujo D8 continuo sobre FABDEM."""
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

    vis, par, W_int, N_int = visited, parent, W, N
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
    ac_log = np.where((ctx == 1) | (ctx == 9), 0.0, np.log10(np.maximum(1.0, acc_2d * 4.0)))
    ac_log = np.clip(ac_log, 0.0, 6.2).astype(np.float32)
    bin_flow = np.where((ac_log >= 3.52) & (ctx != 1) & (ctx != 2) & (ctx != 9) & (ctx != 10), 255, 0).astype(np.uint8)
    return ac_log, bin_flow


def save_dem_png(dem: np.ndarray, path: Path):
    norm = np.clip((dem - DEM_MIN) / (DEM_MAX - DEM_MIN), 0.0, 1.0)
    u16 = np.round(norm * 65535.0).astype(np.uint16)
    rgba = np.zeros((dem.shape[0], dem.shape[1], 4), dtype=np.uint8)
    rgba[..., 0] = (u16 >> 8).astype(np.uint8)
    rgba[..., 1] = (u16 & 0xFF).astype(np.uint8)
    rgba[..., 3] = 255
    Image.fromarray(rgba, mode="RGBA").save(path, format="PNG", optimize=True)


def compute_hillshade(dem_hi: np.ndarray) -> np.ndarray:
    dx = (float(_BB["world_w_km"]) * 1000.0) / dem_hi.shape[1]
    dy = (float(_BB["world_h_km"]) * 1000.0) / dem_hi.shape[0]
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


def main():
    # 1) FABDEM -> assets/dem.png (520x429) y grilla 1040x857
    dem_mesh = warp_fabdem(MW, MH)
    dem_hi = warp_fabdem(W, H)
    curate_and_enrich_vectors(dem_hi)
    save_dem_png(dem_mesh, ASSETS_DIR / "dem.png")

    # 2) Reconstruir R,G de layers.png directamente desde vectores fuente (sin lectura circular del HTML)
    risk_u8, ctx_u8 = rasterize_layers_from_vectors(dem_hi)

    # 3) Priority-Flood + D8 continuo sobre FABDEM
    raw_lines = json.loads(OSM_LINES_PATH.read_text(encoding="utf-8")).get("features", []) if OSM_LINES_PATH.exists() else []
    ac_log, bin_flow = compute_fabdem_flow(dem_hi, ctx_u8, raw_lines)
    save_geotiff(OUT_ACUM_TIF, ac_log, gdal.GDT_Float32)
    save_geotiff(OUT_BIN_TIF, bin_flow, gdal.GDT_Byte)

    lay_arr = np.zeros((H, W, 4), dtype=np.uint8)
    lay_arr[..., 0] = risk_u8
    lay_arr[..., 1] = ctx_u8
    lay_arr[..., 2] = bin_flow
    lay_arr[..., 3] = 255
    Image.fromarray(lay_arr, mode="RGBA").save(ASSETS_DIR / "layers.png", format="PNG", optimize=True)

    # 4) assets/acum.png: R,G = ac_log 16-bit (/6.5) + B = hillshade multidireccional
    hs_u8 = compute_hillshade(dem_hi)
    ac_u16 = np.round(np.clip(ac_log / 6.5, 0.0, 1.0) * 65535.0).astype(np.uint16)
    acum_arr = np.zeros((H, W, 4), dtype=np.uint8)
    acum_arr[..., 0] = (ac_u16 >> 8).astype(np.uint8)
    acum_arr[..., 1] = (ac_u16 & 0xFF).astype(np.uint8)
    acum_arr[..., 2] = hs_u8
    acum_arr[..., 3] = 255
    Image.fromarray(acum_arr, mode="RGBA").save(ASSETS_DIR / "acum.png", format="PNG", optimize=True)

    # 5) Sincronizar assets/*.json desde GeoJSONs curados
    ln_out, pm_out = sync_all()
    print(f"FABDEM assets/dem.png: {MW}x{MH} ({(ASSETS_DIR / 'dem.png').stat().st_size // 1024} KB)")
    print(f"Vectores -> assets/layers.png: {W}x{H} ({(ASSETS_DIR / 'layers.png').stat().st_size // 1024} KB) | binFlow={int((bin_flow > 0).sum())} px")
    print(f"FABDEM assets/acum.png: {W}x{H} ({(ASSETS_DIR / 'acum.png').stat().st_size // 1024} KB)")
    print(f"Assets JSON sincronizados: {len(ln_out)} trazas, {len(pm_out)} bombeos")


if __name__ == "__main__":
    main()
