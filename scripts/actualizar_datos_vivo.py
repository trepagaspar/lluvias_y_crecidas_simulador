#!/usr/bin/env python3
"""
Actualiza datos_en_vivo.json con datos oficiales gratuitos y en tiempo real:
- Alturas hidrometricas del INA (alerta.ina.gob.ar/a5) definidas en config/region_santa_fe.json
- Lluvia actual y pronostico 48 h de Open-Meteo (api.open-meteo.com) para Santa Fe.

Solo usa la biblioteca estandar de Python (sin dependencias externas).
"""

import argparse
import copy
import datetime
import json
import sys
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CONFIG_FILE = ROOT / "config" / "region_santa_fe.json"
OUT_FILE = ROOT / "datos_en_vivo.json"

UA = "SantaFeSimulador3D/2.0 (https://github.com/trepagaspar/lluvias_y_crecidas_simulador)"

WEATHER_COMPARE_KEYS = (
    "temperatura_c",
    "lluvia_actual_mm",
    "lluvia_ultimas_24h_mm",
    "pronostico_24h_mm",
    "pronostico_48h_mm",
    "pico_horario_48h_mm",
    "prob_max_48h_pct",
)


def load_region_config() -> dict:
    return json.loads(CONFIG_FILE.read_text(encoding="utf-8"))


def fetch_json(url: str, timeout: int = 20):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8", errors="replace"))


def fetch_ina_series(series_id: int, days_back: int = 10):
    now_utc = datetime.datetime.now(datetime.timezone.utc)
    t_start = (now_utc - datetime.timedelta(days=days_back)).strftime("%Y-%m-%d")
    t_end = (now_utc + datetime.timedelta(days=2)).strftime("%Y-%m-%d")
    url = (
        f"https://alerta.ina.gob.ar/a5/obs/puntual/series/{series_id}/observaciones"
        f"?timestart={t_start}&timeend={t_end}"
    )
    rows = fetch_json(url)
    valid = [r for r in rows if r.get("valor") is not None]
    if not valid:
        return None
    valid.sort(key=lambda r: r.get("timestart", ""))
    last = valid[-1]
    prev = valid[-2] if len(valid) >= 2 else None
    val = round(float(last["valor"]), 2)
    delta = round(val - float(prev["valor"]), 2) if prev else 0.0
    return {
        "series_id": series_id,
        "valor_m": val,
        "delta_m": delta,
        "fecha_utc": last.get("timestart"),
        "ultimos_registros": [
            {"fecha_utc": r.get("timestart"), "valor_m": round(float(r["valor"]), 2)}
            for r in valid[-7:]
        ],
    }


def fetch_open_meteo(weather_cfg: dict):
    tz_q = urllib.parse.quote(weather_cfg["timezone"], safe="")
    url = (
        "https://api.open-meteo.com/v1/forecast"
        f"?latitude={weather_cfg['lat']}&longitude={weather_cfg['lon']}"
        "&current=temperature_2m,precipitation,rain"
        "&hourly=precipitation,precipitation_probability"
        "&past_days=1&forecast_days=2"
        f"&timezone={tz_q}"
    )
    d = fetch_json(url)
    cur = d.get("current", {})
    cur_time = cur.get("time", "")
    hourly = d.get("hourly", {})
    times = hourly.get("time", [])
    precs = hourly.get("precipitation", [])
    probs = hourly.get("precipitation_probability", [])

    # Separar pasadas (ultimas 24h moviles) vs futuras (proximas 48h) usando prefijo hora actual
    cur_hour = cur_time[:13] if len(cur_time) >= 13 else ""
    past_vals = []
    next24_mm = 0.0
    next48_mm = 0.0
    max_hr_mm = 0.0
    max_prob = 0
    future_idx = 0

    for t, mm, pr in zip(times, precs, probs):
        mm_v = float(mm or 0.0)
        pr_v = int(pr or 0)
        if cur_hour and t[:13] <= cur_hour:
            past_vals.append(mm_v)
        else:
            if future_idx < 24:
                next24_mm += mm_v
            if future_idx < 48:
                next48_mm += mm_v
                if mm_v > max_hr_mm:
                    max_hr_mm = mm_v
                if pr_v > max_prob:
                    max_prob = pr_v
            future_idx += 1

    past_mm = sum(past_vals[-24:])

    return {
        "fuente": weather_cfg.get("fuente", "Open-Meteo (api.open-meteo.com)"),
        "ubicacion": {
            "lat": weather_cfg["lat"],
            "lon": weather_cfg["lon"],
            "ciudad": weather_cfg["ciudad"],
        },
        "fecha_local": cur_time,
        "temperatura_c": cur.get("temperature_2m"),
        "lluvia_actual_mm": round(float(cur.get("precipitation") or 0.0), 1),
        "lluvia_ultimas_24h_mm": round(past_mm, 1),
        "pronostico_24h_mm": round(next24_mm, 1),
        "pronostico_48h_mm": round(next48_mm, 1),
        "pico_horario_48h_mm": round(max_hr_mm, 1),
        "prob_max_48h_pct": max_prob,
    }


def has_meaningful_change(existing: dict, candidate: dict) -> bool:
    """Compara rios, metricas climaticas y errores ignorando marcas temporales vacias."""
    if not existing:
        return True
    if existing.get("rios") != candidate.get("rios"):
        return True
    if existing.get("errores", []) != candidate.get("errores", []):
        return True
    ex_cl = existing.get("clima") or {}
    ca_cl = candidate.get("clima") or {}
    for k in WEATHER_COMPARE_KEYS:
        if ex_cl.get(k) != ca_cl.get(k):
            return True
    return False


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="Actualiza datos_en_vivo.json desde INA y Open-Meteo.")
    parser.add_argument("--dry-run", action="store_true", help="Consulta y evalua cambios sin escribir archivo.")
    args = parser.parse_args(argv)

    cfg = load_region_config()
    stations = cfg["hydrometry"]["stations"]
    weather_cfg = cfg["weather"]

    existing = {}
    if OUT_FILE.exists():
        try:
            existing = json.loads(OUT_FILE.read_text(encoding="utf-8"))
        except Exception:
            existing = {}

    now_iso = datetime.datetime.now(datetime.timezone.utc).isoformat()
    out = {
        "actualizado_utc": now_iso,
        "rios": copy.deepcopy(existing.get("rios", {})),
        "clima": copy.deepcopy(existing.get("clima", {})),
        "errores": [],
    }

    total_sources = len(stations) + 1
    succeeded = 0

    for st in stations:
        key = st["key"]
        try:
            res = fetch_ina_series(int(st["series_id"]))
            if res:
                res["nombre"] = st["nombre"]
                res["alerta_m"] = st.get("alerta_m")
                res["evacuacion_m"] = st.get("evacuacion_m")
                res["fuente"] = st.get("fuente", "INA (alerta.ina.gob.ar)")
                out["rios"][key] = res
                succeeded += 1
            else:
                out["errores"].append(f"INA {key}: sin datos recientes")
        except Exception as exc:
            out["errores"].append(f"INA {key}: {exc}")

    try:
        out["clima"] = fetch_open_meteo(weather_cfg)
        succeeded += 1
    except Exception as exc:
        out["errores"].append(f"Open-Meteo: {exc}")

    if succeeded == 0:
        print(f"ERROR: fallaron todas las fuentes ({total_sources}/{total_sources}). Se conserva {OUT_FILE.name} intacto.", file=sys.stderr)
        for err in out["errores"]:
            print(f"  - {err}", file=sys.stderr)
        return 1

    changed = has_meaningful_change(existing, out)
    if not changed:
        print(f"Sin cambios relevantes en mediciones ({succeeded}/{total_sources} fuentes OK). No se modifica {OUT_FILE.name}.")
        return 0

    if args.dry_run:
        print(f"[dry-run] Habria cambios en {OUT_FILE.name} ({succeeded}/{total_sources} fuentes OK).")
    else:
        OUT_FILE.write_text(json.dumps(out, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(f"Actualizado {OUT_FILE}")

    print("  Parana SF :", out["rios"].get("parana_santa_fe", {}).get("valor_m"), "m")
    print("  Salado ST :", out["rios"].get("salado_santo_tome", {}).get("valor_m"), "m")
    print(
        "  Clima     :",
        out["clima"].get("temperatura_c"),
        "C | 24h:",
        out["clima"].get("pronostico_24h_mm"),
        "mm | 48h:",
        out["clima"].get("pronostico_48h_mm"),
        "mm",
    )
    if out["errores"]:
        print("  Errores parciales:", out["errores"])
    return 0


if __name__ == "__main__":
    sys.exit(main())
