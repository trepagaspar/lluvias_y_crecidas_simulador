#!/usr/bin/env python3
"""
Validador hidraulico y benchmark de rendimiento de Fase 6 (solo Python estandar + Node.js).
Ejecuta `src/sim-engine.js` sobre los assets reales del proyecto para verificar:
  - Test A: Cierre de balance de masa (< 1% error) en tormenta 90 mm / 2 h.
  - Test B: Benchmark CPU (ms por subpaso y ms por frame).
  - Test C: Evaluacion de escenarios base (3,30 m / Rios hoy) y eventos historicos si existen.
"""

import json
import struct
import subprocess
import sys
import tempfile
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def decode_png_rgba(path: Path) -> bytes:
    data = path.read_bytes()
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError(f"{path} no es un PNG valido")

    pos = 8
    w = h = bd = ct = 0
    idat_parts = []
    while pos < len(data):
        length = struct.unpack(">I", data[pos : pos + 4])[0]
        ctype = data[pos + 4 : pos + 8]
        chunk = data[pos + 8 : pos + 8 + length]
        pos += 12 + length
        if ctype == b"IHDR":
            w, h, bd, ct, _comp, _filt, inter = struct.unpack(">IIBBBBB", chunk)
            if bd != 8 or ct not in (2, 6) or inter != 0:
                raise ValueError(f"Formato PNG no soportado en {path}: bd={bd} ct={ct} inter={inter}")
        elif ctype == b"IDAT":
            idat_parts.append(chunk)
        elif ctype == b"IEND":
            break

    bpp = 4 if ct == 6 else 3
    stride = w * bpp
    raw = zlib.decompress(b"".join(idat_parts))
    out = bytearray(w * h * 4)
    prev = bytearray(stride)
    src = 0

    for row in range(h):
        ftype = raw[src]
        src += 1
        scan = bytearray(raw[src : src + stride])
        src += stride

        if ftype == 1:
            for i in range(bpp, stride):
                scan[i] = (scan[i] + scan[i - bpp]) & 0xFF
        elif ftype == 2:
            for i in range(stride):
                scan[i] = (scan[i] + prev[i]) & 0xFF
        elif ftype == 3:
            for i in range(stride):
                left = scan[i - bpp] if i >= bpp else 0
                scan[i] = (scan[i] + ((left + prev[i]) >> 1)) & 0xFF
        elif ftype == 4:
            for i in range(stride):
                a = scan[i - bpp] if i >= bpp else 0
                b = prev[i]
                c = prev[i - bpp] if i >= bpp else 0
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                scan[i] = (scan[i] + pr) & 0xFF
        elif ftype != 0:
            raise ValueError(f"Filtro PNG desconocido: {ftype}")

        prev = scan
        dst = row * w * 4
        if bpp == 4:
            out[dst : dst + stride] = scan
        else:
            for x in range(w):
                si = x * 3
                di = dst + x * 4
                out[di] = scan[si]
                out[di + 1] = scan[si + 1]
                out[di + 2] = scan[si + 2]
                out[di + 3] = 255

    return bytes(out)


NODE_RUNNER = r"""
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { createSimEngine } from "./src/sim-engine.js";

const tmpDir = process.argv[2];
const regionCfg = JSON.parse(fs.readFileSync("./config/region_santa_fe.json", "utf8"));
const cityPumps = JSON.parse(fs.readFileSync("./assets/city_pumps.json", "utf8"));
const osmLines = JSON.parse(fs.readFileSync("./assets/osm_lines.json", "utf8"));
const liveData = fs.existsSync("./datos_en_vivo.json")
  ? JSON.parse(fs.readFileSync("./datos_en_vivo.json", "utf8"))
  : null;

const ov = regionCfg.research_overrides || {};
const loadOv = key => (ov[key] && fs.existsSync(ov[key]) ? JSON.parse(fs.readFileSync(ov[key], "utf8")) : null);

const demRGBA = fs.readFileSync(path.join(tmpDir, "dem.rgba"));
const layersRGBA = fs.readFileSync(path.join(tmpDir, "layers.rgba"));
const acumRGBA = fs.readFileSync(path.join(tmpDir, "acum.rgba"));

const bb = regionCfg.bbox;
const gr = regionCfg.grid;
const hy = regionCfg.hydrometry;
const cfg = {
  W: gr.w,
  H: gr.h,
  MW: gr.mw,
  MH: gr.mh,
  SW: gr.sw,
  SH: gr.sh,
  lonMin: bb.lon_min,
  lonMax: bb.lon_max,
  latMin: bb.lat_min,
  latMax: bb.lat_max,
  worldW: bb.world_w_km,
  worldH: bb.world_h_km,
  demMin: gr.dem_min_m,
  demMax: gr.dem_max_m,
  PARANA_NORMAL: hy.parana_normal_m,
  SALADO_NORMAL: hy.salado_normal_m,
};

const heightsM = new Float32Array(cfg.MW * cfg.MH);
for (let i = 0; i < cfg.MW * cfg.MH; i++) {
  const u16 = (demRGBA[i * 4] << 8) | demRGBA[i * 4 + 1];
  heightsM[i] = cfg.demMin + (u16 / 65535.0) * (cfg.demMax - cfg.demMin);
}

const sim = createSimEngine({
  cfg,
  heightsM,
  layersRGBA,
  acumRGBA,
  cityPumps,
  osmLines,
  researchOverrides: {
    defensas: loadOv("defensas"),
    bombeo_capacidades: loadOv("bombeo_capacidades"),
    reservorios: loadOv("reservorios"),
    puntos_criticos_empiricos: loadOv("puntos_criticos_empiricos"),
  },
});

// 1. Escenarios fluviales base (sin lluvia)
sim.resetWaterOnly();
sim.state.paranaScale = cfg.PARANA_NORMAL;
sim.state.saladoScale = cfg.SALADO_NORMAL;
sim.stepSubsteps(210, false);
const normalState = {
  urbanFloodHa: sim.state.urbanFloodHa,
  extFloodHa: sim.state.extFloodHa,
  maxUrbanCm: sim.state.maxUrbanCm,
};

const liveParana = liveData?.rios?.parana_santa_fe?.valor_m ?? cfg.PARANA_NORMAL;
const liveSalado = liveData?.rios?.salado_santo_tome?.valor_m ?? cfg.SALADO_NORMAL;
sim.resetWaterOnly();
sim.state.paranaScale = liveParana;
sim.state.saladoScale = liveSalado;
sim.stepSubsteps(210, false);
const todayState = {
  parana: liveParana,
  salado: liveSalado,
  urbanFloodHa: sim.state.urbanFloodHa,
  extFloodHa: sim.state.extFloodHa,
  maxUrbanCm: sim.state.maxUrbanCm,
};

// 2. Test A: Balance de masa cerrado (90 mm / 2 h, rios normales, bombeo activo)
sim.resetWaterOnly();
sim.state.paranaScale = cfg.PARANA_NORMAL;
sim.state.saladoScale = cfg.SALADO_NORMAL;
sim.state.targetMm = 90;
sim.state.durationHr = 2.0;
sim.state.drainMode = "partial";
sim.state.stormProfile = "uniform";
sim.state.soilMode = "wet";
sim.state.cityPumpsActive = true;
sim.state.running = true;
sim.stepSubsteps(260, true);

const mb = { ...sim.state.massBalance };
const totalIn = mb.rainInM3 + (mb.riverInM3 || 0);
const accounted = mb.storedM3 + mb.drainOutM3 + mb.pumpOutM3 + mb.borderOutM3 + mb.riverOutM3;
const errAbs = Math.abs(totalIn - accounted);
const errPct = totalIn > 0 ? (errAbs / totalIn) * 100 : 0;

// 2b. Test A2: Balance de masa combinado (crecida actual + tormenta 90 mm / 2 h)
sim.resetWaterOnly();
sim.state.paranaScale = liveParana;
sim.state.saladoScale = liveSalado;
sim.state.targetMm = 90;
sim.state.durationHr = 2.0;
sim.state.drainMode = "saturated";
sim.state.stormProfile = "convective";
sim.state.soilMode = "saturated";
sim.state.cityPumpsActive = true;
sim.state.running = true;
sim.stepSubsteps(260, true);

const mb2 = { ...sim.state.massBalance };
const totalIn2 = mb2.rainInM3 + (mb2.riverInM3 || 0);
const accounted2 = mb2.storedM3 + mb2.drainOutM3 + mb2.pumpOutM3 + mb2.borderOutM3 + mb2.riverOutM3;
const errAbs2 = Math.abs(totalIn2 - accounted2);
const errPct2 = totalIn2 > 0 ? (errAbs2 / totalIn2) * 100 : 0;

// 3. Test B: Benchmark CPU (100 frames x 4 substeps + 25 updateMetrics)
sim.resetWaterOnly();
sim.state.paranaScale = cfg.PARANA_NORMAL;
sim.state.saladoScale = cfg.SALADO_NORMAL;
sim.state.drainMode = "partial";
sim.state.stormProfile = "uniform";
sim.state.soilMode = "wet";
sim.state.targetMm = 90;
sim.state.durationHr = 2.0;
sim.state.running = true;
const t0 = performance.now();
for (let f = 0; f < 100; f++) {
  sim.stepSubsteps(4, true, { skipMetrics: f % 4 !== 0 });
}
const dtMs = performance.now() - t0;

// 4. Test C: Eventos historicos de calibracion (si existen)
// Evalua profundidad pico al cierre de tormenta en radio barrial (~450 m) para evitar sesgo de 1 solo pixel
function sampleBarrioPeakCm(u, v, radKm = 0.45) {
  let maxM = sim.sampleWaterAtUV(u, v);
  const du = radKm / cfg.worldW;
  const dv = radKm / cfg.worldH;
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      if (dx === 0 && dy === 0) continue;
      const dist2 = (dx * 0.5) * (dx * 0.5) + (dy * 0.5) * (dy * 0.5);
      if (dist2 > 1.05) continue;
      const su = Math.max(0, Math.min(1, u + dx * 0.5 * du));
      const sv = Math.max(0, Math.min(1, v + dy * 0.5 * dv));
      const w = sim.sampleWaterAtUV(su, sv);
      if (w > maxM) maxM = w;
    }
  }
  return Math.round(maxM * 100);
}

const eventosCfg = loadOv("eventos_calibracion");
const eventosOut = [];
if (eventosCfg && Array.isArray(eventosCfg.eventos)) {
  for (const ev of eventosCfg.eventos) {
    sim.resetWaterOnly();
    sim.state.paranaScale = Number(ev.parana_m ?? cfg.PARANA_NORMAL);
    sim.state.saladoScale = Number(ev.salado_m ?? cfg.SALADO_NORMAL);
    sim.state.targetMm = Number(ev.lluvia_mm ?? 0);
    sim.state.durationHr = Number(ev.duracion_h ?? 2.0);
    sim.state.stormProfile = ev.perfil || "uniform";
    sim.state.drainMode = ev.drenaje || "partial";
    sim.state.soilMode = ev.suelo || (ev.drenaje === "saturated" ? "saturated" : "wet");
    sim.state.running = true;
    // Evaluar al cierre del pico de tormenta (+0,25 h de concentracion)
    const steps = Math.max(120, Math.ceil(((sim.state.durationHr + 0.25) / 0.015)));
    sim.stepSubsteps(steps, sim.state.targetMm > 0);
    const affectedPlaces = [];
    for (const p of regionCfg.places) {
      if (!p.barrio_ref) continue;
      const u = (p.lon - cfg.lonMin) / (cfg.lonMax - cfg.lonMin);
      const v = (cfg.latMax - p.lat) / (cfg.latMax - cfg.latMin);
      const wCm = sampleBarrioPeakCm(u, v, 0.45);
      if (wCm >= 8) affectedPlaces.push({ name: p.name, wCm });
    }
    affectedPlaces.sort((a, b) => b.wCm - a.wCm);
    const realSet = new Set(ev.barrios_anegados_reales || []);
    const hits = affectedPlaces.filter(x => realSet.has(x.name)).map(x => `${x.name} (${x.wCm} cm)`);
    eventosOut.push({
      nombre: ev.nombre,
      urbanFloodHa: sim.state.urbanFloodHa,
      extFloodHa: sim.state.extFloodHa,
      hits,
      hitRate: realSet.size > 0 ? Math.round((hits.length / realSet.size) * 100) : null,
      affectedPlaces: affectedPlaces.slice(0, 10),
      barrios_reales: ev.barrios_anegados_reales || [],
    });
  }
}

console.log(JSON.stringify({
  normalState,
  todayState,
  massBalance: { ...mb, totalIn: Math.round(totalIn), accounted: Math.round(accounted), errAbs: Math.round(errAbs), errPct },
  massBalanceFloodStorm: { ...mb2, totalIn: Math.round(totalIn2), accounted: Math.round(accounted2), errAbs: Math.round(errAbs2), errPct: errPct2 },
  benchmark: { totalMs100Frames: dtMs, msPerFrame4Substeps: dtMs / 100, msPerSubstep: dtMs / 400 },
  eventos: eventosOut,
}, null, 2));
"""


def main() -> int:
    with tempfile.TemporaryDirectory() as tmp:
        tmp_dir = Path(tmp)
        for name in ("dem", "layers", "acum"):
            raw = decode_png_rgba(ROOT / "assets" / f"{name}.png")
            (tmp_dir / f"{name}.rgba").write_bytes(raw)

        runner_path = tmp_dir / "validate_sim.mjs"
        # Import relativo al repo desde temp no resuelve bien en ESM, pasamos path absoluto
        node_code = NODE_RUNNER.replace('./src/sim-engine.js', (ROOT / "src" / "sim-engine.js").as_uri())
        runner_path.write_text(node_code, encoding="utf-8")

        res = subprocess.run(
            ["node", str(runner_path), str(tmp_dir)],
            cwd=str(ROOT),
            capture_output=True,
            text=True,
        )
        if res.returncode != 0:
            print("ERROR ejecutando runner Node:", res.stderr, file=sys.stderr)
            return 1

        report = json.loads(res.stdout)

    ns = report["normalState"]
    ts = report["todayState"]
    mb = report["massBalance"]
    mb_fs = report["massBalanceFloodStorm"]
    bm = report["benchmark"]

    print(f"[Base Normal 3,30/3,20 m] Ciudad >10cm: {ns['urbanFloodHa']} ha | Costa/Islas: {ns['extFloodHa']} ha | Max ciudad: {ns['maxUrbanCm']} cm")
    print(f"[Rios Hoy {ts['parana']:.2f}/{ts['salado']:.2f} m] Ciudad >10cm: {ts['urbanFloodHa']} ha | Costa/Islas: {ts['extFloodHa']} ha | Max ciudad: {ts['maxUrbanCm']} cm")
    print(
        f"[Test A - Balance de masa 90 mm/2h] Ingreso: {mb['totalIn']:,} m3 | "
        f"Salidas+Almac.: {mb['accounted']:,} m3 (almac={mb['storedM3']:,}, dren={mb['drainOutM3']:,.0f}, "
        f"bomb={mb['pumpOutM3']:,.0f}, borde={mb['borderOutM3']:,.0f}, rios={mb['riverOutM3']:,.0f}) | "
        f"Error: {mb['errPct']:.4f}%"
    )
    print(
        f"[Test A2 - Balance crecida+tormenta] Ingreso total: {mb_fs['totalIn']:,} m3 | "
        f"Salidas+Almac.: {mb_fs['accounted']:,} m3 | Error: {mb_fs['errPct']:.4f}%"
    )
    print(
        f"[Test B - Benchmark CPU] 100 frames (4 subpasos c/u): {bm['totalMs100Frames']:.1f} ms | "
        f"{bm['msPerFrame4Substeps']:.2f} ms/frame | {bm['msPerSubstep']:.2f} ms/subpaso"
    )
    if report["eventos"]:
        print("[Test C - Eventos historicos]")
        for ev in report["eventos"]:
            hr = f" | aciertos={ev['hitRate']}% ({ev['hits']})" if ev.get("hitRate") is not None else ""
            print(f"  - {ev['nombre']}: ciudad={ev['urbanFloodHa']} ha, costa={ev['extFloodHa']} ha{hr}")
    else:
        print("[Test C - Eventos historicos] Sin config/eventos_calibracion.json configurado (omitido).")

    if mb["errPct"] >= 1.0 or mb_fs["errPct"] >= 1.0:
        print(f"FALLO: error de balance de masa ({mb['errPct']:.4f}% / {mb_fs['errPct']:.4f}%) >= 1.0%", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
