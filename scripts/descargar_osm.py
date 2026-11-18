#!/usr/bin/env python3
"""
Descarga capas abiertas de OpenStreetMap (via Overpass API, 100% gratuito)
para el area metropolitana de Santa Fe (excluyendo la margen entrerriana):
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
import math
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

PLACES_REF = [
    ("Microcentro", -60.7100, -31.6466),
    ("Candioti", -60.6960, -31.6400),
    ("Puerto", -60.6960, -31.6490),
    ("Parque del Sur", -60.7115, -31.6625),
    ("Centenario", -60.7220, -31.6620),
    ("Santa Rosa de Lima", -60.7335, -31.6435),
    ("Barranquitas", -60.7285, -31.6225),
    ("Parque Garay", -60.7203, -31.6359),
    ("Parque Federal", -60.6955, -31.6221),
    ("Guadalupe", -60.6785, -31.5980),
    ("Las Flores / Hipódromo", -60.7190, -31.6020),
    ("Reservorios Oeste", -60.7425, -31.5880),
    ("Reservorio Norte", -60.7526, -31.5727),
    ("Loyola / Los Troncos", -60.7420, -31.5765),
    ("Cabaña Leiva", -60.7260, -31.5590),
    ("Alto Verde", -60.6650, -31.6480),
    ("Colastiné / Rincón", -60.6080, -31.6300),
    ("Santo Tomé", -60.7640, -31.6710),
    ("Monte Vera", -60.6800, -31.5250),
]

SUBTIPO_ES = {
    "hospital": "Hospital / Sanatorio",
    "clinic": "Centro de Salud / Clínica",
    "doctors": "Consultorio / CAPS",
    "centre": "Centro de Salud",
    "school": "Escuela",
    "kindergarten": "Jardín de Infantes",
    "college": "Instituto Terciario",
    "university": "Facultad / Universidad",
    "fire_station": "Cuartel de Bomberos",
    "police": "Comisaría / Destacamento Policial",
}


def is_entre_rios(lon: float, lat: float) -> bool:
    # Esquina SE al otro lado del canal principal del Rio Parana (Bajada Grande / Parana, Entre Rios)
    return lat < -31.685 and lon > -60.605


def nearest_barrio(lon: float, lat: float) -> str:
    best_name = "Gran Santa Fe"
    best_d = 1e9
    for name, plon, plat in PLACES_REF:
        d = math.hypot((lon - plon) * 95.0, (lat - plat) * 111.0)
        if d < best_d:
            best_d = d
            best_name = name
    return best_name


def format_facility_name(raw_name: str, subtipo: str, street: str, barrio: str) -> str:
    label_es = SUBTIPO_ES.get(subtipo, "Establecimiento")
    clean = (raw_name or "").strip()
    if not clean or "(sin nombre)" in clean.lower():
        if street:
            return f"{label_es} ({street}, {barrio})"
        return f"{label_es} s/n (zona {barrio})"
    return clean


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


def download_equipamiento():
    ql = f"""
    [out:json][timeout:35];
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
        lon_f, lat_f = float(lon), float(lat)
        if is_entre_rios(lon_f, lat_f):
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

        street = (tags.get("addr:street") or "").strip()
        barrio = nearest_barrio(lon_f, lat_f)
        raw_name = tags.get("name") or tags.get("official_name") or ""
        nombre = format_facility_name(raw_name, subtipo, street, barrio)
        key = (cat, round(lon_f, 4), round(lat_f, 4), nombre.lower())
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
                "direccion": street,
                "barrio_cercano": barrio,
                "fuente": "OpenStreetMap (Overpass API)",
            },
            "geometry": {"type": "Point", "coordinates": [round(lon_f, 6), round(lat_f, 6)]},
        })

    out_path = OUT_DIR / "osm_equipamiento_critico.geojson"
    fc = {"type": "FeatureCollection", "name": "osm_equipamiento_critico", "features": features}
    out_path.write_text(json.dumps(fc, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    counts = {}
    for f in features:
        c = f["properties"]["categoria"]
        counts[c] = counts.get(c, 0) + 1
    print(f"Guardado {out_path} ({len(features)} puntos Gran Santa Fe): {counts}")


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
        coords = [[round(float(pt["lon"]), 6), round(float(pt["lat"]), 6)] for pt in geom]
        if all(is_entre_rios(lon, lat) for lon, lat in coords):
            continue
        tags = el.get("tags") or {}
        ww = tags.get("waterway", "")
        mm = tags.get("man_made", "")
        tipo = "defensa" if mm in ("embankment", "dyke", "levee") else "canal_zanja"
        subtipo = mm if tipo == "defensa" else ww
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
    time.sleep(1)
    download_canales_defensas()
