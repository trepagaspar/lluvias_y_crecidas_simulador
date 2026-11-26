#!/usr/bin/env python3
"""
Descarga capas abiertas de infraestructura hidrica de OpenStreetMap (via Overpass API)
para el area metropolitana de Santa Fe (excluyendo la margen entrerriana):
  - datos/vectores/osm_canales_defensas.geojson
    * Canales, zanjas y desagues a cielo abierto (waterway=drain/ditch/canal)
    * Terraplenes y defensas (man_made=embankment/dyke/levee)

Preserva atributos derivados de FABDEM (cota_media_fabdem_m)
de features ya existentes por osm_id para evitar regresiones en CI.
Solo usa la biblioteca estandar de Python.
"""

import json
import math
import time
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CONFIG_FILE = ROOT / "config" / "region_santa_fe.json"
OUT_DIR = ROOT / "datos" / "vectores"
OUT_DIR.mkdir(parents=True, exist_ok=True)

_CFG = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
_BB = _CFG["bbox"]
_ER = _CFG["entre_rios_filter"]

BBOX = f"{_BB['lat_min']:.6f},{_BB['lon_min']:.6f},{_BB['lat_max']:.6f},{_BB['lon_max']:.6f}"
ENDPOINTS = [
    "https://overpass.openstreetmap.fr/api/interpreter",
    "https://overpass.osm.jp/api/interpreter",
    "https://overpass-api.de/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
]
UA = "SantaFeSimulador3D/2.0 (https://github.com/trepagaspar/lluvias_y_crecidas_simulador)"


def is_entre_rios(lon: float, lat: float) -> bool:
    # Esquina SE al otro lado del canal principal del Rio Parana (Bajada Grande / Parana, Entre Rios)
    return lat < float(_ER["osm_lat_lt"]) and lon > float(_ER["osm_lon_gt"])


def compute_line_length_m(coords) -> float:
    length_m = 0.0
    for (x0, y0), (x1, y1) in zip(coords[:-1], coords[1:]):
        length_m += math.hypot((x1 - x0) * 94800.0, (y1 - y0) * 110880.0)
    return round(length_m, 1)


def load_existing_by_osm_id(path: Path) -> dict:
    if not path.exists():
        return {}
    try:
        fc = json.loads(path.read_text(encoding="utf-8"))
        out = {}
        for feat in fc.get("features", []):
            oid = (feat.get("properties") or {}).get("osm_id")
            if oid:
                out[oid] = feat.get("properties") or {}
        return out
    except Exception:
        return {}


def write_geojson_if_changed(path: Path, fc: dict) -> bool:
    new_text = json.dumps(fc, ensure_ascii=False, indent=2) + "\n"
    if path.exists():
        try:
            if path.read_text(encoding="utf-8") == new_text:
                return False
        except Exception:
            pass
    path.write_text(new_text, encoding="utf-8")
    return True


def query_overpass(ql: str, timeout: int = 45):
    data = urllib.parse.urlencode({"data": ql}).encode("utf-8")
    last_err = None
    for ep in ENDPOINTS:
        try:
            req = urllib.request.Request(ep, data=data, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return json.loads(resp.read().decode("utf-8", errors="replace"))
        except Exception as exc:
            last_err = exc
            print(f"  Mirror {ep} fallo: {exc}")
            time.sleep(2)
    raise RuntimeError(f"Todos los servidores Overpass fallaron: {last_err}")


def download_canales_defensas():
    ql = f"""
    [out:json][timeout:30];
    (
      way["waterway"="drain"]({BBOX});
      way["waterway"="ditch"]({BBOX});
      way["waterway"="canal"]({BBOX});
      way["man_made"="embankment"]({BBOX});
      way["man_made"="dyke"]({BBOX});
      way["man_made"="levee"]({BBOX});
    );
    out geom tags;
    """
    out_path = OUT_DIR / "osm_canales_defensas.geojson"
    prev_by_id = load_existing_by_osm_id(out_path)

    print("Descargando canales, zanjas y defensas desde OSM...")
    doc = query_overpass(ql)
    features = []
    preserved_cotas = 0
    for el in doc.get("elements", []):
        if el.get("type") != "way":
            continue
        geom = el.get("geometry") or []
        if len(geom) < 2:
            continue
        coords = [[round(float(pt["lon"]), 6), round(float(pt["lat"]), 6)] for pt in geom]
        if all(is_entre_rios(lon, lat) for lon, lat in coords):
            continue
        tags = el.get("tags") or {}
        ww = tags.get("waterway", "")
        mm = tags.get("man_made", "")
        tipo = "defensa" if mm in ("embankment", "dyke", "levee") else "canal_zanja"
        subtipo = mm if tipo == "defensa" else ww
        osm_id = f"way/{el.get('id')}"
        props = {
            "osm_id": osm_id,
            "tipo": tipo,
            "subtipo": subtipo,
            "nombre": tags.get("name", ""),
            "fuente": "OpenStreetMap (Overpass API)",
            "longitud_m": compute_line_length_m(coords),
        }
        prev_props = prev_by_id.get(osm_id)
        if prev_props and "cota_media_fabdem_m" in prev_props:
            props["cota_media_fabdem_m"] = prev_props["cota_media_fabdem_m"]
            preserved_cotas += 1

        features.append({
            "type": "Feature",
            "properties": props,
            "geometry": {"type": "LineString", "coordinates": coords},
        })

    fc = {"type": "FeatureCollection", "name": "osm_canales_defensas", "features": features}
    written = write_geojson_if_changed(out_path, fc)
    counts = {}
    for f in features:
        t = f["properties"]["tipo"]
        counts[t] = counts.get(t, 0) + 1
    status = "Guardado" if written else "Sin cambios en"
    print(f"{status} {out_path} ({len(features)} trazas, {preserved_cotas} cotas medias FABDEM preservadas): {counts}")


if __name__ == "__main__":
    download_canales_defensas()
