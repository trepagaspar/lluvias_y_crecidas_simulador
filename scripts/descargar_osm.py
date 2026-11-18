#!/usr/bin/env python3
"""
Descarga capas abiertas de OpenStreetMap (via Overpass API, 100% gratuito)
para el area metropolitana de Santa Fe:
  1) datos/vectores/osm_equipamiento_critico.geojson
     - Centros de salud, hospitales y CAPS
     - Escuelas, jardines y universidades
     - Bomberos y comisarias
  2) datos/vectores/osm_canales_defensas.geojson
     - Canales, zanjas y desagues a cielo abierto (waterway=drain/ditch/canal)
     - Terraplenes y defensas (man_made=embankment/dyke/levee)

Solo usa la biblioteca estandar de Python.
"""

import json
import time
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "datos" / "vectores"
OUT_DIR.mkdir(parents=True, exist_ok=True)

# Bounding box del visor 3D (south, west, north, east)
BBOX = "-31.7205,-60.8201,-31.4895,-60.5398"
ENDPOINTS = [
    "https://overpass.openstreetmap.fr/api/interpreter",
    "https://overpass.osm.jp/api/interpreter",
    "https://overpass-api.de/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
]
UA = "SantaFeSimulador3D/1.0 (https://github.com/trepagaspar/lluvias_y_crecidas_simulador)"


def query_overpass(ql: str, timeout: int = 50):
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


def download_equipamiento():
    ql = f"""
    [out:json][timeout:40];
    (
      nwr["amenity"~"^(hospital|clinic|doctors|school|kindergarten|college|university|fire_station|police)$"]({BBOX});
      nwr["healthcare"~"^(hospital|clinic|centre)$"]({BBOX});
    );
    out center tags;
    """
    print("Descargando equipamiento critico desde OSM...")
    doc = query_overpass(ql)
    features = []
    seen = set()
    for el in doc.get("elements", []):
        tags = el.get("tags") or {}
        lat = el.get("lat") if "lat" in el else (el.get("center") or {}).get("lat")
        lon = el.get("lon") if "lon" in el else (el.get("center") or {}).get("lon")
        if lat is None or lon is None:
            continue
        am = tags.get("amenity", "")
        hc = tags.get("healthcare", "")
        if am in ("hospital", "clinic", "doctors") or hc in ("hospital", "clinic", "centre"):
            cat = "salud"
            subtipo = am or hc
        elif am in ("fire_station", "police"):
            cat = "emergencia"
            subtipo = am
        else:
            cat = "escuela"
            subtipo = am or "school"

        nombre = tags.get("name") or tags.get("official_name") or f"{subtipo} (sin nombre)"
        key = (cat, round(lon, 4), round(lat, 4), nombre.lower())
        if key in seen:
            continue
        seen.add(key)

        features.append({
            "type": "Feature",
            "properties": {
                "osm_id": f"{el.get('type')}/{el.get('id')}",
                "categoria": cat,
                "subtipo": subtipo,
                "nombre": nombre,
                "direccion": tags.get("addr:street", ""),
                "fuente": "OpenStreetMap (Overpass API)",
            },
            "geometry": {"type": "Point", "coordinates": [round(float(lon), 6), round(float(lat), 6)]},
        })

    out_path = OUT_DIR / "osm_equipamiento_critico.geojson"
    fc = {"type": "FeatureCollection", "name": "osm_equipamiento_critico", "features": features}
    out_path.write_text(json.dumps(fc, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    counts = {}
    for f in features:
        c = f["properties"]["categoria"]
        counts[c] = counts.get(c, 0) + 1
    print(f"Guardado {out_path} ({len(features)} puntos): {counts}")


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
    print("Descargando canales, zanjas y defensas desde OSM...")
    doc = query_overpass(ql)
    features = []
    for el in doc.get("elements", []):
        if el.get("type") != "way":
            continue
        geom = el.get("geometry") or []
        if len(geom) < 2:
            continue
        tags = el.get("tags") or {}
        ww = tags.get("waterway", "")
        mm = tags.get("man_made", "")
        tipo = "defensa" if mm in ("embankment", "dyke", "levee") else "canal_zanja"
        subtipo = mm if tipo == "defensa" else ww
        coords = [[round(float(pt["lon"]), 6), round(float(pt["lat"]), 6)] for pt in geom]
        features.append({
            "type": "Feature",
            "properties": {
                "osm_id": f"way/{el.get('id')}",
                "tipo": tipo,
                "subtipo": subtipo,
                "nombre": tags.get("name", ""),
                "fuente": "OpenStreetMap (Overpass API)",
            },
            "geometry": {"type": "LineString", "coordinates": coords},
        })

    out_path = OUT_DIR / "osm_canales_defensas.geojson"
    fc = {"type": "FeatureCollection", "name": "osm_canales_defensas", "features": features}
    out_path.write_text(json.dumps(fc, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    counts = {}
    for f in features:
        t = f["properties"]["tipo"]
        counts[t] = counts.get(t, 0) + 1
    print(f"Guardado {out_path} ({len(features)} trazas): {counts}")


if __name__ == "__main__":
    download_equipamiento()
    download_canales_defensas()
