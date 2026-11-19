// Motor hidrológico-hidráulico 2D (lluvia, ríos Paraná/Salado, canales/defensas OSM, reservorios y bombeo)
// Independiente del refresh rate (dt real), conservativo en lluvia y preparado para overrides data-driven (Fase 6).

export const WATER_THRESHOLDS = Object.freeze({
  VISIBLE_M: 0.04, // 4 cm: inicio visual y diagnóstico somero
  KPI_M: 0.10,     // 10 cm: umbral de afectación en KPIs y equipamiento
  MED_M: 0.15,     // 15 cm: anegamiento medio
  DEEP_M: 0.40,    // 40 cm: inundación profunda
});

export function scaleToParanaRise(sc) {
  if (sc <= 3.50) return 0.0;
  if (sc <= 5.30) return (sc - 3.50) * 0.72;
  if (sc <= 6.00) return 1.296 + (sc - 5.30) * 1.10;
  return 2.066 + (sc - 6.00) * 1.35;
}

export function scaleToSaladoRise(sc) {
  if (sc <= 3.50) return 0.0;
  if (sc <= 4.70) return (sc - 3.50) * 0.45;
  if (sc <= 6.20) return 0.54 + (sc - 4.70) * 0.85;
  return 1.815 + (sc - 6.20) * 1.25;
}

// Factor de intensidad relativa para hietograma (integral normalizada = 1.0 sobre [0, 1])
export function stormIntensityFactor(progress01, profile) {
  if (profile !== "convective") return 1.0;
  const p = Math.max(0, Math.min(1, progress01));
  // Hietograma triangular asimétrico (pico en 40% de la tormenta, integral exacta = 1.0)
  // Base mínima 0.25 + triángulo de área 0.75 (altura adicional 1.50 => pico total 1.75x)
  const peak = 0.40;
  const tri = p <= peak ? (p / peak) : ((1 - p) / (1 - peak));
  return 0.25 + 1.50 * Math.max(0, tri);
}

function rasterizeLineOnGrid(u0, v0, u1, v1, SW, SH, cb) {
  const x0 = u0 * (SW - 1), y0 = v0 * (SH - 1);
  const x1 = u1 * (SW - 1), y1 = v1 * (SH - 1);
  const steps = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) * 2));
  for (let k = 0; k <= steps; k++) {
    const t = k / steps;
    const c = Math.max(0, Math.min(SW - 1, Math.round(x0 + (x1 - x0) * t)));
    const r = Math.max(0, Math.min(SH - 1, Math.round(y0 + (y1 - y0) * t)));
    cb(r * SW + c);
  }
}

export function createSimEngine({
  cfg,
  heightsM,
  layersRGBA,
  acumRGBA,
  cityPumps,
  osmFacilities,
  osmLines,
  researchOverrides = {},
}) {
  const SW = cfg.SW;
  const SH = cfg.SH;
  const S_N = SW * SH;
  const cellAreaM2 = ((cfg.worldW * 1000) / SW) * ((cfg.worldH * 1000) / SH);
  const cellAreaHa = cellAreaM2 / 10000.0;

  const simZ = new Float32Array(S_N);
  const simBaseP = new Float32Array(S_N);
  const simBaseS = new Float32Array(S_N);
  const simW = new Float32Array(S_N);
  const simDW = new Float32Array(S_N);
  const simRunoff = new Float32Array(S_N);
  const simDrain = new Float32Array(S_N);
  const simManningInv = new Float32Array(S_N);
  const simPumpRateMhr = new Float32Array(S_N);
  const simType = new Uint8Array(S_N);      // 0=rural/bajo, 1=Paraná/Setúbal, 2=Reservorio, 3=Ciudad alta (IV), 4=Salado
  const simProtected = new Uint8Array(S_N); // 1=protegido por anillo de defensa
  const simDefenseCrown = new Float32Array(S_N);
  const waterTexBytes = new Uint8Array(S_N * 4);
  for (let i = 3; i < waterTexBytes.length; i += 4) waterTexBytes[i] = 255;

  const defaultDefenseCrown = Number(researchOverrides?.defensas?.cota_defecto_m) || 16.20;
  const resDesignDepthM = Number(researchOverrides?.reservorios?.profundidad_defecto_m) || 1.20;

  // Mapa opcional de capacidades reales de bombeo (m³/s) por id de estación (Fase 6)
  const pumpCapById = new Map();
  if (Array.isArray(researchOverrides?.bombeo_capacidades?.estaciones)) {
    for (const st of researchOverrides.bombeo_capacidades.estaciones) {
      if (st && st.id != null && Number(st.caudal_m3s) > 0) {
        pumpCapById.set(Number(st.id), Number(st.caudal_m3s));
      }
    }
  }

  let totalResCells = 0;

  for (let sr = 0; sr < SH; sr++) {
    const mr = Math.min(cfg.MH - 1, Math.round(((sr + 0.5) / SH) * (cfg.MH - 1)));
    const lr = Math.min(cfg.H - 1, Math.round(((sr + 0.5) / SH) * (cfg.H - 1)));
    for (let sc = 0; sc < SW; sc++) {
      const mc = Math.min(cfg.MW - 1, Math.round(((sc + 0.5) / SW) * (cfg.MW - 1)));
      const lc = Math.min(cfg.W - 1, Math.round(((sc + 0.5) / SW) * (cfg.W - 1)));
      const si = sr * SW + sc;
      const li = (lr * cfg.W + lc) * 4;

      simZ[si] = heightsM[mr * cfg.MW + mc];
      const rNorm = sr / Math.max(1, SH - 1);
      // Pendiente hidráulica realista del Paraná (~4,2 cm/km, anclada en Puerto SF sr=145 -> 11,10 m)
      simBaseP[si] = 11.10 + (145 - sr) * 0.005;
      simBaseS[si] = 14.00 - 1.90 * rNorm;

      const riskId = layersRGBA[li];
      const ctxId = layersRGBA[li + 1];

      if (ctxId === 1 || ctxId === 2) {
        simType[si] = 1;
        simRunoff[si] = 1.0;
        simDrain[si] = 0.25;
        simManningInv[si] = 1.15;
      } else if (ctxId === 9 || ctxId === 10) {
        simType[si] = 4;
        simRunoff[si] = 1.0;
        simDrain[si] = 0.25;
        simManningInv[si] = 1.15;
      } else if (ctxId === 7 || ctxId === 8) {
        simType[si] = 2;
        simRunoff[si] = 1.0;
        simDrain[si] = 0.004;
        simManningInv[si] = 0.72;
        totalResCells++;
      } else if (ctxId === 3 || ctxId === 4 || riskId === 2) {
        simType[si] = 0;
        simRunoff[si] = 0.45;
        simDrain[si] = 0.024;
        simManningInv[si] = 0.52; // parques / islas vegetadas (mayor rugosidad Manning)
      } else {
        simType[si] = riskId === 1 ? 3 : 0;
        simRunoff[si] = riskId === 1 ? 0.88 : 0.72;
        simDrain[si] = riskId === 1 ? 0.018 : 0.010;
        simManningInv[si] = riskId === 1 ? 1.00 : 0.65;
      }

      simProtected[si] = simType[si] === 2 || simType[si] === 3 ? 1 : 0;
      simDefenseCrown[si] = defaultDefenseCrown;
    }
  }

  // Integrar canales (-0.35 m, Manning rápido) y defensas (+0.80 m) de OSM en el ruteo dinámico
  for (const ln of osmLines || []) {
    if (!ln.p || ln.p.length < 2) continue;
    const isCanal = ln.t === "c";
    for (let k = 0; k < ln.p.length - 1; k++) {
      rasterizeLineOnGrid(ln.p[k][0], ln.p[k][1], ln.p[k + 1][0], ln.p[k + 1][1], SW, SH, idx => {
        if (simType[idx] === 1 || simType[idx] === 4) return;
        if (isCanal) {
          simZ[idx] -= 0.35;
          simManningInv[idx] = Math.max(simManningInv[idx], 1.25);
        } else {
          simZ[idx] += 0.80;
          simDefenseCrown[idx] = Math.max(simDefenseCrown[idx], simZ[idx]);
        }
      });
    }
  }

  // Aplicar tramos de defensa con cota real si existen overrides de Fase 6
  if (Array.isArray(researchOverrides?.defensas?.tramos)) {
    for (const tr of researchOverrides.defensas.tramos) {
      const cota = Number(tr.cota_coronamiento_m);
      const pts = tr.uv || [];
      if (!Number.isFinite(cota) || pts.length < 2) continue;
      for (let k = 0; k < pts.length - 1; k++) {
        rasterizeLineOnGrid(pts[k][0], pts[k][1], pts[k + 1][0], pts[k + 1][1], SW, SH, idx => {
          simDefenseCrown[idx] = cota;
          simZ[idx] = Math.max(simZ[idx], cota);
        });
      }
    }
  }

  // Precalcular factor de bombeo municipal por celda (59 estaciones)
  for (let sr = 0; sr < SH; sr++) {
    for (let sc = 0; sc < SW; sc++) {
      const si = sr * SW + sc;
      if (simProtected[si] || (simType[si] === 0 && simZ[si] >= 13.5)) {
        const pu = (sc + 0.5) / SW;
        const pv = (sr + 0.5) / SH;
        let bestRateMhr = 0.0;
        for (const cp of cityPumps) {
          const dkm = Math.hypot((cp.u - pu) * cfg.worldW, (cp.v - pv) * cfg.worldH);
          if (dkm < 1.8) {
            const wGauss = Math.exp(-(dkm * dkm) / (0.85 * 0.85));
            const capM3s = pumpCapById.get(cp.id);
            // Si hay capacidad real en m³/s (Fase 6), convertir sobre huella efectiva (~120 ha); si no, calibración base moderada
            const baseMhr = capM3s ? Math.min(0.35, (capM3s * 3600) / 1.2e6) : 0.14;
            const rate = baseMhr * wGauss;
            if (rate > bestRateMhr) bestRateMhr = rate;
          }
        }
        if (simType[si] === 2) bestRateMhr = Math.max(bestRateMhr * 1.45, 0.08);
        simPumpRateMhr[si] = bestRateMhr;
      }
    }
  }

  // Pre-indexar celdas con bombeo activo para evitar recorrer 55 900 celdas en cada subpaso
  let activePumpCount = 0;
  for (let i = 0; i < S_N; i++) {
    if (simPumpRateMhr[i] > 0) activePumpCount++;
  }
  const pumpIdxArr = new Int32Array(activePumpCount);
  const pumpRateArr = new Float32Array(activePumpCount);
  let pPtr = 0;
  for (let i = 0; i < S_N; i++) {
    if (simPumpRateMhr[i] > 0) {
      pumpIdxArr[pPtr] = i;
      pumpRateArr[pPtr] = simPumpRateMhr[i];
      pPtr++;
    }
  }

  const manualPumps = [];
  const state = {
    running: false,
    riverSettle: 0,
    pumpSettle: 0,
    cityPumpsActive: true,
    targetMm: 0,
    durationHr: 2.0,
    paranaScale: cfg.PARANA_NORMAL,
    saladoScale: cfg.SALADO_NORMAL,
    drainMode: "partial",       // partial | saturated
    stormProfile: "uniform",    // uniform | convective
    soilMode: "auto",           // auto | dry | wet | saturated
    antecedentRain24h: 0,
    fallenMm: 0,
    elapsedHr: 0,
    maxUrbanCm: 0,
    urbanFloodHa: 0,
    extFloodHa: 0,
    resFillPct: 0,
    saludFlood: 0,
    escuelasFlood: 0,
    emergFlood: 0,
    massBalance: {
      rainInM3: 0,
      drainOutM3: 0,
      pumpOutM3: 0,
      borderOutM3: 0,
      riverOutM3: 0,
      storedM3: 0,
    },
  };

  let simAccSec = 0;
  const SUBSTEPS_PER_SEC = 160; // Independiente de 60Hz / 120Hz / 144Hz

  function getSoilRunoffMultiplier() {
    if (state.soilMode === "dry") return 0.86;
    if (state.soilMode === "wet") return 1.00;
    if (state.soilMode === "saturated") return 1.12;
    // auto: basado en lluvia real últimas 24 h (Open-Meteo)
    const r24 = Math.max(0, Number(state.antecedentRain24h || 0));
    if (r24 < 3) return 0.88;
    if (r24 < 25) return 0.88 + ((r24 - 3) / 22) * 0.14;
    return Math.min(1.12, 1.02 + ((r24 - 25) / 40) * 0.10);
  }

  function sampleHeightAtUV(u, v) {
    if (u < 0 || u > 1 || v < 0 || v > 1) return 15.0;
    const fx = u * (cfg.MW - 1), fy = v * (cfg.MH - 1);
    const x0 = Math.floor(fx), y0 = Math.floor(fy);
    const x1 = Math.min(x0 + 1, cfg.MW - 1), y1 = Math.min(y0 + 1, cfg.MH - 1);
    const tx = fx - x0, ty = fy - y0;
    const h00 = heightsM[y0 * cfg.MW + x0], h10 = heightsM[y0 * cfg.MW + x1];
    const h01 = heightsM[y1 * cfg.MW + x0], h11 = heightsM[y1 * cfg.MW + x1];
    return (h00 * (1 - tx) + h10 * tx) * (1 - ty) + (h01 * (1 - tx) + h11 * tx) * ty;
  }

  function sampleWaterAtUV(u, v) {
    if (u < 0 || u > 1 || v < 0 || v > 1) return 0;
    const zHere = sampleHeightAtUV(u, v);
    const fx = u * (SW - 1), fy = v * (SH - 1);
    const x0 = Math.floor(fx), y0 = Math.floor(fy);
    const x1 = Math.min(x0 + 1, SW - 1), y1 = Math.min(y0 + 1, SH - 1);
    const tx = fx - x0, ty = fy - y0;
    const effW = idx => {
      const w = simW[idx];
      if (w <= 0) return 0;
      return simZ[idx] < zHere - 0.6 ? Math.max(0, simZ[idx] + w - zHere) : w;
    };
    const w00 = effW(y0 * SW + x0), w10 = effW(y0 * SW + x1);
    const w01 = effW(y1 * SW + x0), w11 = effW(y1 * SW + x1);
    return (w00 * (1 - tx) + w10 * tx) * (1 - ty) + (w01 * (1 - tx) + w11 * tx) * ty;
  }

  function updateWaterBytes() {
    const scale = 65535.0 / 6.0;
    for (let i = 0; i < S_N; i++) {
      const w = simW[i];
      const u16 = w <= 0 ? 0 : w >= 6.0 ? 65535 : (w * scale + 0.5) | 0;
      const j = i << 2;
      waterTexBytes[j] = u16 >> 8;
      waterTexBytes[j + 1] = u16 & 0xff;
    }
    return waterTexBytes;
  }

  function updateMetrics() {
    let urbanWet = 0, extWet = 0, maxU = 0, resSum = 0, storedM3 = 0;
    for (let i = 0; i < S_N; i++) {
      const w = simW[i];
      const t = simType[i];
      if (t !== 1 && t !== 4) storedM3 += w * cellAreaM2;
      if (t === 3) {
        if (w > WATER_THRESHOLDS.KPI_M) urbanWet++;
        if (simZ[i] >= 12.0 && w > maxU) maxU = w;
      } else if (t === 2) {
        resSum += Math.min(1.0, w / resDesignDepthM);
      } else if (t === 0 && w > WATER_THRESHOLDS.KPI_M) {
        extWet++;
      }
    }
    state.urbanFloodHa = Math.round(urbanWet * cellAreaHa);
    state.extFloodHa = Math.round(extWet * cellAreaHa);
    state.maxUrbanCm = Math.round(maxU * 100);
    state.resFillPct = totalResCells > 0 ? Math.min(100, Math.round((resSum / totalResCells) * 100)) : 0;
    state.massBalance.storedM3 = Math.round(storedM3);

    const kpiCmThreshold = Math.round(WATER_THRESHOLDS.KPI_M * 100);
    let sHit = 0, eHit = 0, xHit = 0;
    for (let i = 0; i < osmFacilities.length; i++) {
      const f = osmFacilities[i];
      if (Math.round(sampleWaterAtUV(f.u, f.v) * 100) > kpiCmThreshold) {
        if (f.t === "s") sHit++;
        else if (f.t === "e") eHit++;
        else xHit++;
      }
    }
    state.saludFlood = sHit;
    state.escuelasFlood = eHit;
    state.emergFlood = xHit;
  }

  function resetWaterOnly() {
    state.fallenMm = 0;
    state.elapsedHr = 0;
    simAccSec = 0;
    simW.fill(0);
    state.massBalance.rainInM3 = 0;
    state.massBalance.drainOutM3 = 0;
    state.massBalance.pumpOutM3 = 0;
    state.massBalance.borderOutM3 = 0;
    state.massBalance.riverOutM3 = 0;
    state.massBalance.storedM3 = 0;
  }

  function dropLocalRain(u, v, mmAmount) {
    const cx = u * SW, cy = v * SH, rad = 10;
    const x0 = Math.max(1, Math.floor(cx - rad)), x1 = Math.min(SW - 2, Math.ceil(cx + rad));
    const y0 = Math.max(1, Math.floor(cy - rad)), y1 = Math.min(SH - 2, Math.ceil(cy + rad));
    for (let r = y0; r <= y1; r++) {
      for (let c = x0; c <= x1; c++) {
        const d2 = (c - cx) * (c - cx) + (r - cy) * (r - cy);
        if (d2 <= rad * rad) {
          const idx = r * SW + c;
          if (simType[idx] !== 1 && simType[idx] !== 4) {
            const addM = mmAmount * 0.001 * Math.exp(-d2 / (0.38 * rad * rad));
            simW[idx] += addM;
            state.massBalance.rainInM3 += addM * cellAreaM2;
          }
        }
      }
    }
    if (!state.running) state.running = true;
    updateMetrics();
  }

  function addManualPump(u, v) {
    if (manualPumps.length >= 5) manualPumps.shift();
    manualPumps.push({ u, v });
    state.running = true;
    return manualPumps.length;
  }

  function clearManualPumps() {
    manualPumps.length = 0;
  }

  function areManualPumpsDry() {
    if (!manualPumps.length) return true;
    for (const p of manualPumps) {
      const px = p.u * SW, py = p.v * SH, rad = 5.5;
      const x0 = Math.max(1, Math.floor(px - rad)), x1 = Math.min(SW - 2, Math.ceil(px + rad));
      const y0 = Math.max(1, Math.floor(py - rad)), y1 = Math.min(SH - 2, Math.ceil(py + rad));
      for (let r = y0; r <= y1; r++) {
        for (let c = x0; c <= x1; c++) {
          const d2 = (c - px) * (c - px) + (r - py) * (r - py);
          if (d2 <= rad * rad) {
            const idx = r * SW + c;
            if (simType[idx] !== 1 && simType[idx] !== 4 && simW[idx] > 0.005) return false;
          }
        }
      }
    }
    return true;
  }

  function stepSubsteps(subSteps, rainEnabled = true, options = {}) {
    const { skipMetrics = false, maxMs = 0 } = options;
    const t0 = maxMs > 0 && typeof performance !== "undefined" ? performance.now() : 0;
    const durHr = Math.max(0.25, state.durationHr);
    const meanRateMmHr = state.targetMm / durHr;
    const dtHr = 0.015;
    const soilMult = getSoilRunoffMultiplier();

    const backP = state.paranaScale > 4.2 ? Math.max(0.15, 1.0 - (state.paranaScale - 4.2) / 2.6) : 1.0;
    const backS = state.saladoScale > 4.0 ? Math.max(0.15, 1.0 - (state.saladoScale - 4.0) / 3.0) : 1.0;
    const riverBackwater = Math.min(backP, backS);
    const drainScale = (state.drainMode === "saturated" ? 0.08 : 1.0) * riverBackwater;
    const INV_SQRT2 = 0.70710678;

    const riseP = scaleToParanaRise(state.paranaScale);
    const riseS = scaleToSaladoRise(state.saladoScale);

    for (let s = 0; s < subSteps; s++) {
      let rainM = 0;
      if (rainEnabled && state.fallenMm < state.targetMm) {
        const progress = Math.min(1, state.elapsedHr / durHr);
        const factor = stormIntensityFactor(progress, state.stormProfile);
        const stepMm = Math.min(state.targetMm - state.fallenMm, meanRateMmHr * factor * dtHr);
        state.fallenMm += stepMm;
        rainM = stepMm * 0.001;
      }
      if (rainEnabled) state.elapsedHr += dtHr;
      simDW.fill(0);

      for (let i = 0; i < S_N; i++) {
        const t = simType[i];
        if (t === 1) {
          simW[i] = riseP > 0.01 ? Math.max(0.0, simBaseP[i] + riseP - simZ[i]) : simW[i] * 0.72;
          continue;
        }
        if (t === 4) {
          simW[i] = riseS > 0.01 ? Math.max(0.0, simBaseS[i] + riseS - simZ[i]) : simW[i] * 0.72;
          continue;
        }
        let w = simW[i];
        if (rainM > 0) {
          // Conservación de masa: sin factor artificial simAcumBoost
          const effRunoff = Math.min(0.98, simRunoff[i] * soilMult);
          const addM = rainM * effRunoff;
          w += addM;
          state.massBalance.rainInM3 += addM * cellAreaM2;
        }
        if (rainEnabled && w > 0) {
          const loss = Math.min(w, simDrain[i] * drainScale * dtHr);
          w -= loss;
          state.massBalance.drainOutM3 += loss * cellAreaM2;
        }
        simW[i] = w > 0 ? w : 0;
      }

      if (state.cityPumpsActive) {
        for (let k = 0; k < pumpIdxArr.length; k++) {
          const i = pumpIdxArr[k];
          if (simW[i] > 0) {
            const rem = Math.min(simW[i], pumpRateArr[k] * dtHr);
            simW[i] -= rem;
            state.massBalance.pumpOutM3 += rem * cellAreaM2;
          }
        }
      }

      for (const p of manualPumps) {
        const px = p.u * SW, py = p.v * SH, rad = 5.5;
        const x0 = Math.max(1, Math.floor(px - rad)), x1 = Math.min(SW - 2, Math.ceil(px + rad));
        const y0 = Math.max(1, Math.floor(py - rad)), y1 = Math.min(SH - 2, Math.ceil(py + rad));
        for (let r = y0; r <= y1; r++) {
          for (let c = x0; c <= x1; c++) {
            const d2 = (c - px) * (c - px) + (r - py) * (r - py);
            if (d2 <= rad * rad) {
              const idx = r * SW + c;
              if (simType[idx] === 1 || simType[idx] === 4) continue;
              const rem = Math.min(simW[idx], 0.014 * Math.exp(-d2 / 14.0));
              simW[idx] -= rem;
              state.massBalance.pumpOutM3 += rem * cellAreaM2;
            }
          }
        }
      }

      for (let r = 1; r < SH - 1; r++) {
        const rowOff = r * SW;
        for (let c = 1; c < SW - 1; c++) {
          const i = rowOff + c;
          const w = simW[i];
          if (w < 0.001) continue;
          const h = simZ[i] + w;
          const srcExt = !simProtected[i];
          const n0 = i - 1, n1 = i + 1, n2 = i - SW, n3 = i + SW;
          const n4 = i - SW - 1, n5 = i - SW + 1, n6 = i + SW - 1, n7 = i + SW + 1;

          const d0 = srcExt && simProtected[n0] && h < simDefenseCrown[n0] ? 0 : h - (simZ[n0] + simW[n0]);
          const d1 = srcExt && simProtected[n1] && h < simDefenseCrown[n1] ? 0 : h - (simZ[n1] + simW[n1]);
          const d2 = srcExt && simProtected[n2] && h < simDefenseCrown[n2] ? 0 : h - (simZ[n2] + simW[n2]);
          const d3 = srcExt && simProtected[n3] && h < simDefenseCrown[n3] ? 0 : h - (simZ[n3] + simW[n3]);
          const d4 = srcExt && simProtected[n4] && h < simDefenseCrown[n4] ? 0 : (h - (simZ[n4] + simW[n4])) * INV_SQRT2;
          const d5 = srcExt && simProtected[n5] && h < simDefenseCrown[n5] ? 0 : (h - (simZ[n5] + simW[n5])) * INV_SQRT2;
          const d6 = srcExt && simProtected[n6] && h < simDefenseCrown[n6] ? 0 : (h - (simZ[n6] + simW[n6])) * INV_SQRT2;
          const d7 = srcExt && simProtected[n7] && h < simDefenseCrown[n7] ? 0 : (h - (simZ[n7] + simW[n7])) * INV_SQRT2;

          let sumD = 0, maxD = 0;
          if (d0 > 0) { sumD += d0; if (d0 > maxD) maxD = d0; }
          if (d1 > 0) { sumD += d1; if (d1 > maxD) maxD = d1; }
          if (d2 > 0) { sumD += d2; if (d2 > maxD) maxD = d2; }
          if (d3 > 0) { sumD += d3; if (d3 > maxD) maxD = d3; }
          if (d4 > 0) { sumD += d4; if (d4 > maxD) maxD = d4; }
          if (d5 > 0) { sumD += d5; if (d5 > maxD) maxD = d5; }
          if (d6 > 0) { sumD += d6; if (d6 > maxD) maxD = d6; }
          if (d7 > 0) { sumD += d7; if (d7 > maxD) maxD = d7; }
          if (sumD <= 0) continue;

          // Velocidad ponderada por rugosidad Manning con límite de estabilidad CFL (<= 0.42)
          const depthScale = Math.min(1.15, 0.55 + Math.sqrt(w) * 1.15);
          const flowCoeff = Math.min(0.42, 0.34 * simManningInv[i] * depthScale);
          const outTotal = Math.min(w, flowCoeff * maxD);
          const k = outTotal / sumD;
          simDW[i] -= outTotal;
          if (d0 > 0) simDW[n0] += d0 * k;
          if (d1 > 0) simDW[n1] += d1 * k;
          if (d2 > 0) simDW[n2] += d2 * k;
          if (d3 > 0) simDW[n3] += d3 * k;
          if (d4 > 0) simDW[n4] += d4 * k;
          if (d5 > 0) simDW[n5] += d5 * k;
          if (d6 > 0) simDW[n6] += d6 * k;
          if (d7 > 0) simDW[n7] += d7 * k;
        }
      }

      for (let i = 0; i < S_N; i++) {
        const t = simType[i];
        if ((t === 1 && riseP <= 0.01) || (t === 4 && riseS <= 0.01)) {
          if (simDW[i] > 0) state.massBalance.riverOutM3 += simDW[i] * cellAreaM2;
          simW[i] = 0;
          continue;
        }
        const nw = simW[i] + simDW[i];
        simW[i] = nw > 0 ? nw : 0;
      }

      // Drenaje abierto en los 4 bordes del dominio (N, S, O, E)
      for (let c = 0; c < SW; c++) {
        const top = c, bot = (SH - 1) * SW + c;
        if (simType[top] !== 1 && simType[top] !== 4) {
          const loss = simW[top] * 0.5; simW[top] -= loss; state.massBalance.borderOutM3 += loss * cellAreaM2;
        }
        if (simType[bot] !== 1 && simType[bot] !== 4) {
          const loss = simW[bot] * 0.5; simW[bot] -= loss; state.massBalance.borderOutM3 += loss * cellAreaM2;
        }
      }
      for (let r = 1; r < SH - 1; r++) {
        const left = r * SW, right = r * SW + (SW - 1);
        if (simType[left] !== 1 && simType[left] !== 4) {
          const loss = simW[left] * 0.5; simW[left] -= loss; state.massBalance.borderOutM3 += loss * cellAreaM2;
        }
        if (simType[right] !== 1 && simType[right] !== 4) {
          const loss = simW[right] * 0.5; simW[right] -= loss; state.massBalance.borderOutM3 += loss * cellAreaM2;
        }
      }

      if (maxMs > 0 && s + 1 < subSteps && performance.now() - t0 >= maxMs) break;
    }

    if (!skipMetrics) updateMetrics();
    if (
      rainEnabled &&
      state.fallenMm >= state.targetMm &&
      state.elapsedHr >= state.durationHr + 1.5 &&
      areManualPumpsDry()
    ) {
      state.running = false;
    }
  }

  // Avance independiente de la tasa de refresco (60 Hz / 120 Hz / 144 Hz) con presupuesto anti-lag
  function advanceWall(dtWallSec, { updateMetricsNow = true } = {}) {
    if (!state.running && state.riverSettle <= 0 && state.pumpSettle <= 0) return false;
    const clampedDt = Math.min(0.05, Math.max(0.001, dtWallSec));
    simAccSec += clampedDt;
    const targetSubsteps = Math.floor(simAccSec * SUBSTEPS_PER_SEC);
    if (targetSubsteps <= 0) return false;
    simAccSec -= targetSubsteps / SUBSTEPS_PER_SEC;
    const steps = Math.min(4, targetSubsteps);

    if (state.running) {
      stepSubsteps(steps, true, { skipMetrics: !updateMetricsNow, maxMs: 9 });
    } else {
      const settleSteps = state.riverSettle > 0 ? Math.min(5, Math.max(steps, 4)) : steps;
      stepSubsteps(settleSteps, false, { skipMetrics: !updateMetricsNow, maxMs: 9 });
      if (state.riverSettle > 0) state.riverSettle = Math.max(0, state.riverSettle - 1);
      if (state.pumpSettle > 0) state.pumpSettle = Math.max(0, state.pumpSettle - 1);
    }
    return true;
  }

  function getFacilityImpacts(catCode) {
    const hits = [];
    let totalCat = 0;
    for (const f of osmFacilities) {
      if (f.t !== catCode) continue;
      totalCat++;
      const wCm = Math.round(sampleWaterAtUV(f.u, f.v) * 100);
      if (wCm > Math.round(WATER_THRESHOLDS.KPI_M * 100)) {
        hits.push({ ...f, wCm });
      }
    }
    hits.sort((a, b) => b.wCm - a.wCm);
    return { hits, totalCat };
  }

  function getQuickSample(u, v) {
    const lon = cfg.lonMin + u * (cfg.lonMax - cfg.lonMin);
    const lat = cfg.latMax - v * (cfg.latMax - cfg.latMin);
    const elev = sampleHeightAtUV(u, v);
    const wM = sampleWaterAtUV(u, v);
    const wCm = Math.round(wM * 100);
    const px = Math.min(cfg.W - 1, Math.max(0, Math.round(u * (cfg.W - 1))));
    const py = Math.min(cfg.H - 1, Math.max(0, Math.round(v * (cfg.H - 1))));
    const idx = (py * cfg.W + px) * 4;
    const rId = layersRGBA[idx], cId = layersRGBA[idx + 1], binVal = layersRGBA[idx + 2];
    const acU16 = (acumRGBA[idx] << 8) | acumRGBA[idx + 1];
    const acVal = acU16 === 0 ? 0 : Math.pow(10, (acU16 / 65535.0) * 6.5);
    return { lon, lat, elev, wM, wCm, rId, cId, binVal, acVal };
  }

  function getPointDiagnostics(u, v, places, forcedName = null) {
    const base = getQuickSample(u, v);
    const { lon, lat } = base;

    let placeName = forcedName;
    if (!placeName) {
      let bestD = 1e9, bestP = null;
      for (const p of places) {
        const d = Math.hypot((p.lon - lon) * 95, (p.lat - lat) * 111);
        if (d < bestD) { bestD = d; bestP = p; }
      }
      placeName = bestP
        ? bestD < 0.7
          ? bestP.name
          : `Cerca de ${bestP.name} (${bestD.toFixed(1).replace(".", ",")} km)`
        : "Sector seleccionado";
    }

    let nearPump = null, nearPumpD = 1e9;
    for (const cp of cityPumps) {
      const dKm = Math.hypot((cp.u - u) * cfg.worldW, (cp.v - v) * cfg.worldH);
      if (dKm < nearPumpD) { nearPumpD = dKm; nearPump = cp; }
    }

    let nearFac = null, nearFacD = 1e9;
    for (const f of osmFacilities) {
      const dKm = Math.hypot((f.u - u) * cfg.worldW, (f.v - v) * cfg.worldH);
      if (dKm < nearFacD) { nearFacD = dKm; nearFac = f; }
    }

    return {
      u, v, ...base,
      placeName,
      nearPump: nearPump && nearPumpD < 0.55 ? { ...nearPump, distM: Math.round(nearPumpD * 1000) } : null,
      nearFac: nearFac && nearFacD < 0.55 ? { ...nearFac, distM: Math.round(nearFacD * 1000) } : null,
    };
  }

  return {
    state,
    manualPumps,
    waterTexBytes,
    sampleHeightAtUV,
    sampleWaterAtUV,
    getQuickSample,
    updateWaterBytes,
    updateMetrics,
    resetWaterOnly,
    dropLocalRain,
    addManualPump,
    clearManualPumps,
    stepSubsteps,
    advanceWall,
    getFacilityImpacts,
    getPointDiagnostics,
  };
}
