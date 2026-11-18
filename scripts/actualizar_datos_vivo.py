#!/usr/bin/env python3
"""
Actualiza datos_en_vivo.json con datos oficiales gratuitos y en tiempo real:
- Alturas hidrometricas del INA (alerta.ina.gob.ar/a5):
    * Parana - Puerto Santa Fe (series_id=30, siteCode=30)
    * Salado - Santo Tome (series_id=3044, siteCode=1679)
    * Salado - Recreo RP 70 (series_id=103, siteCode=103)
- Lluvia actual y pronostico 48 h de Open-Meteo (api.open-meteo.com) para Santa Fe.

Solo usa la biblioteca estandar de Python (sin dependencias externas).
"""

import datetime
import json
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT_FILE = ROOT / "datos_en_vivo.json"

UA = "SantaFeSimulador3D/1.0 (https://github.com/trepagaspar/lluvias_y_crecidas_simulador)"


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


def fetch_open_meteo():
    url = (
        "https://api.open-meteo.com/v1/forecast"
        "?latitude=-31.6333&longitude=-60.7000"
        "&current=temperature_2m,precipitation,rain"
        "&hourly=precipitation,precipitation_probability"
        "&past_days=1&forecast_days=2"
        "&timezone=America%2FArgentina%2FCordoba"
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
        "fuente": "Open-Meteo (api.open-meteo.com)",
        "ubicacion": {"lat": -31.6333, "lon": -60.7000, "ciudad": "Santa Fe"},
        "fecha_local": cur_time,
        "temperatura_c": cur.get("temperature_2m"),
        "lluvia_actual_mm": round(float(cur.get("precipitation") or 0.0), 1),
        "lluvia_ultimas_24h_mm": round(past_mm, 1),
        "pronostico_24h_mm": round(next24_mm, 1),
        "pronostico_48h_mm": round(next48_mm, 1),
        "pico_horario_48h_mm": round(max_hr_mm, 1),
        "prob_max_48h_pct": max_prob,
    }


def main():
    existing = {}
    if OUT_FILE.exists():
        try:
            existing = json.loads(OUT_FILE.read_text(encoding="utf-8"))
        except Exception:
            existing = {}

    now_iso = datetime.datetime.now(datetime.timezone.utc).isoformat()
    out = {
        "actualizado_utc": now_iso,
        "rios": existing.get("rios", {}),
        "clima": existing.get("clima", {}),
        "errores": [],
    }

    for key, sid, nombre, alerta, evac in [
        ("parana_santa_fe", 30, "Paraná — Puerto Santa Fe", 5.30, 5.70),
        ("salado_santo_tome", 3044, "Río Salado — Santo Tomé", 4.70, None),
        ("salado_recreo_rp70", 103, "Río Salado — Recreo RP 70", None, None),
    ]:
        try:
            res = fetch_ina_series(sid)
            if res:
                res["nombre"] = nombre
                res["alerta_m"] = alerta
                res["evacuacion_m"] = evac
                res["fuente"] = "INA (alerta.ina.gob.ar)"
                out["rios"][key] = res
            else:
                out["errores"].append(f"INA {key}: sin datos recientes")
        except Exception as exc:
            out["errores"].append(f"INA {key}: {exc}")

    try:
        out["clima"] = fetch_open_meteo()
    except Exception as exc:
        out["errores"].append(f"Open-Meteo: {exc}")

    OUT_FILE.write_text(json.dumps(out, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Actualizado {OUT_FILE}")
    print("  Parana SF :", out["rios"].get("parana_santa_fe", {}).get("valor_m"), "m")
    print("  Salado ST :", out["rios"].get("salado_santo_tome", {}).get("valor_m"), "m")
    print("  Clima     :", out["clima"].get("temperatura_c"), "C | 24h:", out["clima"].get("pronostico_24h_mm"), "mm | 48h:", out["clima"].get("pronostico_48h_mm"), "mm")
    if out["errores"]:
        print("  Errores   :", out["errores"])


if __name__ == "__main__":
    main()
