// Motor hidrológico-hidráulico 2D (lluvia, ríos Paraná/Salado, canales/defensas OSM, reservorios y bombeo)
// Independiente del refresh rate (dt real), conservativo en lluvia y preparado para overrides data-driven (Fase 6).

export const WATER_THRESHOLDS = Object.freeze({
  VISIBLE_M: 0.04, // 4 cm: inicio visual y diagnóstico somero
  KPI_M: 0.10,     // 10 cm: umbral de afectación en KPIs
  MED_M: 0.15,     // 15 cm: anegamiento medio
  DEEP_M: 0.40,    // 40 cm: inundación profunda
});

export function scaleToParanaRise(sc) {
  if (sc <= 3.30) return 0.0;
  if (sc <= 6.00) return (sc - 3.30) * 1.00;
  return 2.70 + (sc - 6.00) * 1.15;
}

export function scaleToSaladoRise(sc) {
  if (sc <= 3.30) return 0.0;
  if (sc <= 6.20) return (sc - 3.30) * 0.90;
  return 2.61 + (sc - 6.20) * 1.10;
}

export function isRiverElevated(paranaScale, saladoScale) {
  return scaleToParanaRise(paranaScale) > 0.01 || scaleToSaladoRise(saladoScale) > 0.01;
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

function rasterizeLineOnGrid(u0, v0, u1, v1, SW, SH, cb, { thick = false } = {}) {
  const x0 = u0 * (SW - 1), y0 = v0 * (SH - 1);
  const x1 = u1 * (SW - 1), y1 = v1 * (SH - 1);
  const steps = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) * 2));
  let prevC = -1, prevR = -1;
  for (let k = 0; k <= steps; k++) {
    const t = k / steps;
    const ut = u0 + (u1 - u0) * t;
    const vt = v0 + (v1 - v0) * t;
    // Ignorar muestras fuera del dominio [0, 1] para no excavar canales falsos sobre los bordes
    if (ut < 0 || ut > 1 || vt < 0 || vt > 1) {
      prevC = -1;
      prevR = -1;
      continue;
    }
    const c = Math.max(0, Math.min(SW - 1, Math.round(ut * (SW - 1))));
    const r = Math.max(0, Math.min(SH - 1, Math.round(vt * (SH - 1))));
    if (thick && prevC !== -1 && prevC !== c && prevR !== r) {
      // Celda puente ortogonal (supercover): evita fugas diagonales en ruteo 8-conectado a través de terraplenes
      cb(prevR * SW + c);
    }
    cb(r * SW + c);
    prevC = c;
    prevR = r;
  }
}

function pointInPolygonUV(u, v, polyUV) {
  let inside = false;
  for (let i = 0, j = polyUV.length - 1; i < polyUV.length; j = i++) {
    const xi = polyUV[i][0], yi = polyUV[i][1];
    const xj = polyUV[j][0], yj = polyUV[j][1];
    const intersect = yi > v !== yj > v && u < ((xj - xi) * (v - yi)) / (yj - yi + 1e-12) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

export function createSimEngine({
  cfg,
  heightsM,
  layersRGBA,
  acumRGBA,
  cityPumps,
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
  const simW = new Float32Array(S_N);
  const simDW = new Float32Array(S_N);
  const simRunoff = new Float32Array(S_N);
  const simDrain = new Float32Array(S_N);
  const simManningInv = new Float32Array(S_N);
  const simPumpRateMhr = new Float32Array(S_N);
  const simResDepthM = new Float32Array(S_N);
  const simType = new Uint8Array(S_N);      // 0=rural/bajo, 1=Paraná/Setúbal, 2=Reservorio, 3=Ciudad alta (IV), 4=Salado
  const simProtected = new Uint8Array(S_N); // 1=protegido por anillo de defensa
  const isOsmDefense = new Uint8Array(S_N); // 1=traza de terraplén/defensa OSM o Fase 6
  const isCanalBurned = new Uint8Array(S_N);// 1=canal OSM ya tallado (evita pozos por doble resta en vértices)
  const nearBarrier = new Uint8Array(S_N);  // 1=celda con algún vecino protegido/defensa (acelera hot-loop 2D)
  const isOutsideDomain = new Uint8Array(S_N); // 1=margen entrerriana SE excluida del dominio hídrico Santa Fe
  const simDefenseCrown = new Float32Array(S_N);
  const simWSurf = new Float32Array(S_N);
  const simProb = new Float32Array(S_N);
  const bfsQ = new Int32Array(S_N);
  const bfsVis = new Uint8Array(S_N);
  const bfsWL = new Float32Array(S_N);
  const waterTexBytes = new Uint8Array(S_N * 4);
  for (let i = 3; i < waterTexBytes.length; i += 4) waterTexBytes[i] = 255;

  const defaultDefenseCrown = Number(researchOverrides?.defensas?.cota_defecto_m) || 16.20;
  const resDesignDepthM = Number(researchOverrides?.reservorios?.profundidad_defecto_m) || 1.20;
  const customCuencos = Array.isArray(researchOverrides?.reservorios?.cuencos)
    ? researchOverrides.reservorios.cuencos.filter(c => c && Number(c.profundidad_util_m) > 0)
    : [];

  // Puntos críticos empíricos (Fase 6) para alertas operativas en vivo
  const criticalPoints = (Array.isArray(researchOverrides?.puntos_criticos_empiricos?.puntos)
    ? researchOverrides.puntos_criticos_empiricos.puntos
    : []
  )
    .filter(pt => pt && Number.isFinite(Number(pt.lon)) && Number.isFinite(Number(pt.lat)))
    .map(pt => ({
      ...pt,
      u: (Number(pt.lon) - cfg.lonMin) / (cfg.lonMax - cfg.lonMin),
      v: (cfg.latMax - Number(pt.lat)) / (cfg.latMax - cfg.latMin),
    }));

  // Mapa de capacidades reales y metadatos operativos de bombeo (Fase 6)
  const pumpCapById = new Map();
  const pumpMetaById = new Map();
  if (Array.isArray(researchOverrides?.bombeo_capacidades?.estaciones)) {
    for (const st of researchOverrides.bombeo_capacidades.estaciones) {
      if (st && st.id != null) {
        const pid = Number(st.id);
        pumpMetaById.set(pid, st);
        if (Number(st.caudal_m3s) > 0) {
          pumpCapById.set(pid, Number(st.caudal_m3s));
        }
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
      // Datum operativo Puerto SF (0 = 8,20 m IGN; sr=150 -> 3,30 m = 11,50 m IGN; 5,80 m = 14,00 m IGN; pendiente ~3,5 cm/km)
      simBaseP[si] = 11.50 + (150 - sr) * 0.0042;
      simResDepthM[si] = resDesignDepthM;

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

      // Excluir margen entrerriana (barranca y meseta SE al otro lado del canal principal del Paraná)
      const pu = (sc + 0.5) / SW;
      const pv = (sr + 0.5) / SH;
      const lonCell = cfg.lonMin + pu * (cfg.lonMax - cfg.lonMin);
      const latCell = cfg.latMax - pv * (cfg.latMax - cfg.latMin);
      const isErCliff = pv > 0.72 && pu > 0.68 && simZ[si] > 15.2 && simType[si] !== 1;
      const isErMargin = latCell < -31.685 && lonCell > -60.605 && simType[si] !== 1;
      if (isErCliff || isErMargin) {
        isOutsideDomain[si] = 1;
      }
    }
  }

  // Dilatar 2 celdas sobre la ladera de la barranca entrerriana para evitar cascadas artificiales en el talud
  for (let pass = 0; pass < 2; pass++) {
    const prevOut = new Uint8Array(isOutsideDomain);
    for (let sr = 1; sr < SH - 1; sr++) {
      if (sr / SH <= 0.70) continue;
      const rowOff = sr * SW;
      for (let sc = 1; sc < SW - 1; sc++) {
        if (sc / SW <= 0.66) continue;
        const si = rowOff + sc;
        if (prevOut[si] || simType[si] === 1 || simZ[si] < 13.8) continue;
        if (prevOut[si - 1] || prevOut[si + 1] || prevOut[si - SW] || prevOut[si + SW]) {
          isOutsideDomain[si] = 1;
        }
      }
    }
  }

  // Integrar canales (-0.35 m, Manning rápido) y defensas (+0.80 m) de OSM sin acumular pozos/picos en vértices
  for (const ln of osmLines || []) {
    if (!ln.p || ln.p.length < 2) continue;
    const isCanal = ln.t === "c";
    for (let k = 0; k < ln.p.length - 1; k++) {
      rasterizeLineOnGrid(
        ln.p[k][0],
        ln.p[k][1],
        ln.p[k + 1][0],
        ln.p[k + 1][1],
        SW,
        SH,
        idx => {
          if (simType[idx] === 1 || simType[idx] === 4) return;
          if (isCanal) {
            if (!isCanalBurned[idx] && !isOsmDefense[idx]) {
              isCanalBurned[idx] = 1;
              simZ[idx] -= 0.35;
            }
            simManningInv[idx] = Math.max(simManningInv[idx], 1.25);
          } else {
            if (!isOsmDefense[idx]) {
              isOsmDefense[idx] = 1;
              simZ[idx] += 0.80;
            }
            simDefenseCrown[idx] = Math.max(simDefenseCrown[idx], simZ[idx]);
          }
        },
        { thick: !isCanal }
      );
    }
  }

  // Aplicar tramos de defensa con cota real si existen overrides de Fase 6 (acepta coordenadas uv o lonlat)
  if (Array.isArray(researchOverrides?.defensas?.tramos)) {
    for (const tr of researchOverrides.defensas.tramos) {
      if (tr.tipologia === "sin_defensa") continue;
      const cota = Number(tr.cota_coronamiento_m);
      let pts = tr.uv;
      if ((!pts || pts.length < 2) && Array.isArray(tr.lonlat)) {
        pts = tr.lonlat.map(([lon, lat]) => [
          (Number(lon) - cfg.lonMin) / (cfg.lonMax - cfg.lonMin),
          (cfg.latMax - Number(lat)) / (cfg.latMax - cfg.latMin),
        ]);
      }
      if (!Number.isFinite(cota) || !pts || pts.length < 2) continue;
      for (let k = 0; k < pts.length - 1; k++) {
        rasterizeLineOnGrid(
          pts[k][0],
          pts[k][1],
          pts[k + 1][0],
          pts[k + 1][1],
          SW,
          SH,
          idx => {
            if (simType[idx] === 2) return;
            if (simType[idx] === 1 || simType[idx] === 4) {
              simType[idx] = 3;
              simRunoff[idx] = 0.80;
              simDrain[idx] = 0.014;
              simManningInv[idx] = 0.85;
            }
            isOsmDefense[idx] = 1;
            simProtected[idx] = 1;
            simDefenseCrown[idx] = Math.max(simDefenseCrown[idx], cota);
            simZ[idx] = Math.max(simZ[idx], cota);
          },
          { thick: true }
        );
      }
    }
  }

  // Aplicar anillos protegidos (polders cerrados: Cordón Oeste RN A007, Alto Verde, El Pozo, Colastiné Sur, La Costa)
  if (Array.isArray(researchOverrides?.defensas?.anillos_protegidos)) {
    const rings = researchOverrides.defensas.anillos_protegidos
      .map(an => {
        const cota = Number(an.cota_coronamiento_m) || defaultDefenseCrown;
        const polyUV = Array.isArray(an.polygon_uv)
          ? an.polygon_uv
          : Array.isArray(an.polygon_lonlat)
            ? an.polygon_lonlat.map(([lon, lat]) => [
                (Number(lon) - cfg.lonMin) / (cfg.lonMax - cfg.lonMin),
                (cfg.latMax - Number(lat)) / (cfg.latMax - cfg.latMin),
              ])
            : [];
        return { cota, decouple: !!an.desacoplar_cauce, polyUV };
      })
      .filter(r => r.polyUV.length >= 3);

    if (rings.length > 0) {
      for (let sr = 0; sr < SH; sr++) {
        const pv = (sr + 0.5) / SH;
        const rowOff = sr * SW;
        for (let sc = 0; sc < SW; sc++) {
          const pu = (sc + 0.5) / SW;
          const si = rowOff + sc;
          for (const rg of rings) {
            if (pointInPolygonUV(pu, pv, rg.polyUV)) {
              simProtected[si] = 1;
              simDefenseCrown[si] = Math.max(simDefenseCrown[si], rg.cota);
              // Desacoplar hidráulicamente píxeles gruesos BH140 que invadían el interior defendido del anillo
              if (rg.decouple && (simType[si] === 1 || simType[si] === 4)) {
                simType[si] = 3;
                simRunoff[si] = 0.78;
                simDrain[si] = 0.014;
                simManningInv[si] = 0.85;
              }
            }
          }
        }
      }
    }
  }

  // Collar de aislamiento hidráulico de 1 celda alrededor de reservorios frente al cauce del Salado
  for (let sr = 1; sr < SH - 1; sr++) {
    const rowOff = sr * SW;
    for (let sc = 1; sc < SW - 1; sc++) {
      const si = rowOff + sc;
      if (simType[si] !== 2) continue;
      const nbrs = [si - 1, si + 1, si - SW, si + SW, si - SW - 1, si - SW + 1, si + SW - 1, si + SW + 1];
      for (let k = 0; k < 8; k++) {
        const nb = nbrs[k];
        if (simType[nb] === 1) continue;
        if (simType[nb] === 4) {
          simType[nb] = 0;
          simRunoff[nb] = 0.72;
          simDrain[nb] = 0.012;
          simManningInv[nb] = 0.68;
        }
        simProtected[nb] = 1;
        simDefenseCrown[nb] = Math.max(simDefenseCrown[nb], defaultDefenseCrown);
      }
    }
  }

  // Invariante estricto: ninguna celda activa de cauce fluvial puede tener simProtected=1 (evita puentes sobre defensas)
  for (let i = 0; i < S_N; i++) {
    if (simType[i] === 1 || simType[i] === 4) simProtected[i] = 0;
  }

  // Aplicar profundidades específicas por cuenco de reservorio si se proveen en Fase 6
  if (customCuencos.length > 0) {
    for (let sr = 0; sr < SH; sr++) {
      for (let sc = 0; sc < SW; sc++) {
        const si = sr * SW + sc;
        if (simType[si] !== 2) continue;
        const pu = (sc + 0.5) / SW;
        const pv = (sr + 0.5) / SH;
        let bestD = 1e9, bestDepth = resDesignDepthM;
        for (const c of customCuencos) {
          if (Number.isFinite(Number(c.lon)) && Number.isFinite(Number(c.lat))) {
            const cu = (Number(c.lon) - cfg.lonMin) / (cfg.lonMax - cfg.lonMin);
            const cv = (cfg.latMax - Number(c.lat)) / (cfg.latMax - cfg.latMin);
            const dKm = Math.hypot((cu - pu) * cfg.worldW, (cv - pv) * cfg.worldH);
            if (dKm < bestD && dKm < 3.0) {
              bestD = dKm;
              bestDepth = Number(c.profundidad_util_m);
            }
          } else {
            bestDepth = Number(c.profundidad_util_m);
          }
        }
        simResDepthM[si] = bestDepth;
      }
    }
  }

  // Pre-marcar celdas adyacentes a defensas/anillos para evitar chequeos de coronamiento en el 97% del dominio
  for (let r = 1; r < SH - 1; r++) {
    const rowOff = r * SW;
    for (let c = 1; c < SW - 1; c++) {
      const i = rowOff + c;
      const srcExt = !simProtected[i];
      const srcDef = isOsmDefense[i] === 1;
      const nbrs = [i - 1, i + 1, i - SW, i + SW, i - SW - 1, i - SW + 1, i + SW - 1, i + SW + 1];
      for (let k = 0; k < 8; k++) {
        const nb = nbrs[k];
        if ((srcExt && simProtected[nb]) || (!srcDef && isOsmDefense[nb])) {
          nearBarrier[i] = 1;
          break;
        }
      }
    }
  }

  // Precalcular tasa de bombeo municipal físicamente acotada por caudal nominal real (m³/s) de cada estación
  // Fijas principales (EB0-EB6, etc.): extraen de reservorios/cuencos y entorno inmediato (<= 0,55 km) según m³/s real
  // Puntos móviles/complementarios: caudal acotado (~0,45 m³/s) en radio local (<= 0,28 km) para no secar artificialmente calles lejanas
  for (const cp of cityPumps) {
    const meta = pumpMetaById.get(Number(cp.id)) || null;
    const isFixed = meta?.tipo === "fija";
    const capM3s = pumpCapById.get(Number(cp.id)) || (isFixed ? 5.0 : 0.45);
    const radKm = isFixed ? 0.55 : 0.28;
    const sigKm = isFixed ? 0.28 : 0.15;

    const cMin = Math.max(0, Math.floor(((cp.u * cfg.worldW - radKm) / cfg.worldW) * SW));
    const cMax = Math.min(SW - 1, Math.ceil(((cp.u * cfg.worldW + radKm) / cfg.worldW) * SW));
    const rMin = Math.max(0, Math.floor(((cp.v * cfg.worldH - radKm) / cfg.worldH) * SH));
    const rMax = Math.min(SH - 1, Math.ceil(((cp.v * cfg.worldH + radKm) / cfg.worldH) * SH));

    const cells = [];
    let wSum = 0;
    for (let sr = rMin; sr <= rMax; sr++) {
      const pv = (sr + 0.5) / SH;
      for (let sc = cMin; sc <= cMax; sc++) {
        const si = sr * SW + sc;
        if (isOutsideDomain[si] || simType[si] === 1 || simType[si] === 4) continue;
        if (!simProtected[si] && simType[si] !== 2 && simZ[si] < 13.2) continue;
        const pu = (sc + 0.5) / SW;
        const dkm = Math.hypot((cp.u - pu) * cfg.worldW, (cp.v - pv) * cfg.worldH);
        if (dkm > radKm) continue;
        // Priorizar extracción dentro de reservorios/cuencos (3x) frente a celdas urbanas adyacentes
        const w = Math.exp(-(dkm * dkm) / (sigKm * sigKm)) * (simType[si] === 2 ? 3.0 : 1.0);
        cells.push([si, w]);
        wSum += w;
      }
    }
    if (wSum > 0) {
      // Integral exacta: sum(rate_i * cellAreaM2) == capM3s * 3600 m³/h
      const totalMhrCells = (capM3s * 3600.0) / cellAreaM2;
      for (let k = 0; k < cells.length; k++) {
        const [si, w] = cells[k];
        const addRate = totalMhrCells * (w / wSum);
        simPumpRateMhr[si] = Math.min(0.45, simPumpRateMhr[si] + addRate);
      }
    }
  }
  // Retiro base moderado en celdas de reservorio conectadas al sistema de cuencos
  for (let i = 0; i < S_N; i++) {
    if (simType[i] === 2 && simPumpRateMhr[i] < 0.03) {
      simPumpRateMhr[i] = 0.03;
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
    recreoScale: 2.90, // Modula remanso vs crecida propia en cuenca del Salado (INA series_id=103)
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
    massBalance: {
      rainInM3: 0,
      riverInM3: 0,
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

  function sampleProbAtUV(u, v) {
    if (u < 0 || u > 1 || v < 0 || v > 1) return 0;
    const fx = u * (SW - 1), fy = v * (SH - 1);
    const x0 = Math.floor(fx), y0 = Math.floor(fy);
    const x1 = Math.min(x0 + 1, SW - 1), y1 = Math.min(y0 + 1, SH - 1);
    const tx = fx - x0, ty = fy - y0;
    const p00 = simProb[y0 * SW + x0], p10 = simProb[y0 * SW + x1];
    const p01 = simProb[y1 * SW + x0], p11 = simProb[y1 * SW + x1];
    return (p00 * (1 - tx) + p10 * tx) * (1 - ty) + (p01 * (1 - tx) + p11 * tx) * ty;
  }

  function updateWaterBytes() {
    const scale = 65535.0 / 6.0;
    const SIGMA_M = 0.60; // Incertidumbre vertical típica de FABDEM (~30 m) en entorno urbano/ribereño
    const visM = WATER_THRESHOLDS.VISIBLE_M;

    for (let i = 0; i < S_N; i++) {
      const w = simW[i];
      const u16 = w <= 0 ? 0 : w >= 6.0 ? 65535 : (w * scale + 0.5) | 0;
      const j = i << 2;
      waterTexBytes[j] = u16 >> 8;
      waterTexBytes[j + 1] = u16 & 0xff;
      if (w >= visM) {
        simWSurf[i] = simZ[i] + w;
        const p = Math.min(1.0, 0.45 + 0.55 * ((w - visM) / 0.55));
        simProb[i] = p;
        waterTexBytes[j + 2] = (p * 255 + 0.5) | 0;
      } else {
        simWSurf[i] = -1e9;
        simProb[i] = 0.0;
        waterTexBytes[j + 2] = 0;
      }
    }

    // Franja sensible (±0,60 m): celdas secas en la corrida base pero a <= 0,60 m de cota respecto al agua vecina
    for (let r = 1; r < SH - 1; r++) {
      const rowOff = r * SW;
      for (let c = 1; c < SW - 1; c++) {
        const i = rowOff + c;
        if (simW[i] >= visM) continue;
        const zi = simZ[i];
        const dstProt = simProtected[i];
        const dstDef = isOsmDefense[i];
        const crown = simDefenseCrown[i] - SIGMA_M;
        let bestMargin = -1e9;

        const n0 = i - 1, n1 = i + 1, n2 = i - SW, n3 = i + SW;
        const n4 = i - SW - 1, n5 = i - SW + 1, n6 = i + SW - 1, n7 = i + SW + 1;
        const nbrs = [n0, n1, n2, n3, n4, n5, n6, n7];
        for (let k = 0; k < 8; k++) {
          const nb = nbrs[k];
          const hs = simWSurf[nb];
          if (hs < -1e8) continue;
          if (((dstProt && !simProtected[nb]) || (dstDef && !isOsmDefense[nb])) && hs < crown) continue;
          const margin = hs - zi;
          if (margin > bestMargin) bestMargin = margin;
        }
        if (bestMargin > -SIGMA_M) {
          const t = Math.min(1.0, (bestMargin + SIGMA_M) / SIGMA_M);
          const p = 0.15 + 0.28 * t;
          simProb[i] = p;
          waterTexBytes[(i << 2) + 2] = (p * 255 + 0.5) | 0;
        }
      }
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
        resSum += Math.min(1.0, w / Math.max(0.25, simResDepthM[i]));
      } else if (t === 0 && w > WATER_THRESHOLDS.KPI_M) {
        extWet++;
      }
    }
    state.urbanFloodHa = Math.round(urbanWet * cellAreaHa);
    state.extFloodHa = Math.round(extWet * cellAreaHa);
    state.maxUrbanCm = Math.round(maxU * 100);
    state.resFillPct = totalResCells > 0 ? Math.min(100, Math.round((resSum / totalResCells) * 100)) : 0;
    state.massBalance.storedM3 = Math.round(storedM3);
  }

  function resetWaterOnly() {
    state.fallenMm = 0;
    state.elapsedHr = 0;
    simAccSec = 0;
    simW.fill(0);
    simProb.fill(0);
    state.massBalance.rainInM3 = 0;
    state.massBalance.riverInM3 = 0;
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
          if (!isOutsideDomain[idx] && simType[idx] !== 1 && simType[idx] !== 4) {
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

  function saladoWaterLevelAtRow(sr, riseS) {
    const rec = Number.isFinite(state.recreoScale) ? state.recreoScale : 2.90;
    const rNorm = sr / Math.max(1, SH - 1);
    // Perfil de cauce menor en aguas normales (~13,05 m en Recreo sr=0 encauzado -> ~11,45 m en Sto. Tomé sr=162)
    const baseNormal = 13.05 - 2.00 * Math.min(0.80, rNorm);
    if (riseS <= 0.01) return baseNormal;

    // Aporte de onda propia del Salado norte (Recreo RP70 > 3,30 m o escenario manual de crecida extraordinaria)
    const riseFromRecreo = Math.max(0, (rec - 3.30) * 0.90);
    let riseManualWave = 0;
    if (state.saladoScale > 6.15) {
      riseManualWave = (state.saladoScale - 6.00) * 1.40;
    }
    if (state.saladoScale > state.paranaScale + 0.35) {
      riseManualWave = Math.max(riseManualWave, (state.saladoScale - state.paranaScale - 0.25) * 1.15);
    }
    const riseNorth = Math.min(riseS, Math.max(riseFromRecreo, riseManualWave));

    // Cuña hidráulica M1: en remanso puro (Recreo ~2,9 m), el remanso de Sto. Tomé se acuña suavemente hacia el norte
    let effRise;
    if (rNorm >= 0.68) {
      effRise = riseS;
    } else if (rNorm <= 0.28) {
      effRise = riseNorth;
    } else {
      const t = (rNorm - 0.28) / 0.40;
      effRise = riseNorth + (riseS - riseNorth) * (t * t);
    }
    return baseNormal + effRise;
  }

  // Llenado de equilibrio fluvial en llanura aluvial NO defendida (islas/bañados conectados por aliviadores)
  function applyRiverEquilibrium(riseP, riseS) {
    if (riseP <= 0.01 && riseS <= 0.01) return;
    bfsVis.fill(0);
    let head = 0, tail = 0;
    for (let sr = 0; sr < SH; sr++) {
      const rowOff = sr * SW;
      const wlSaladoRow = saladoWaterLevelAtRow(sr, riseS);
      for (let sc = 0; sc < SW; sc++) {
        const i = rowOff + sc;
        if (isOutsideDomain[i]) {
          bfsVis[i] = 1;
          continue;
        }
        const t = simType[i];
        if (t === 1) {
          // Si Paraná está normal, actúa como sumidero/barrera: impide que una crecida del Salado inunde el valle del Paraná
          bfsVis[i] = 1;
          if (riseP > 0.01) {
            const wl = simBaseP[i] + riseP;
            bfsWL[i] = wl;
            bfsQ[tail++] = i;
            simW[i] = Math.max(simW[i], Math.max(0.0, wl - simZ[i]));
          }
        } else if (t === 4) {
          bfsVis[i] = 1;
          if (riseS > 0.01) {
            const wl = wlSaladoRow;
            bfsWL[i] = wl;
            bfsQ[tail++] = i;
            simW[i] = Math.max(simW[i], Math.max(0.0, wl - simZ[i]));
          }
        }
      }
    }

    while (head < tail) {
      const cur = bfsQ[head++];
      const wl = bfsWL[cur];
      const cr = (cur / SW) | 0;
      const cc = cur - cr * SW;
      // 4-conectividad en llanura abierta (respeta estrictamente anillo de defensas y terraplenes OSM)
      const nbrs = [
        cc > 0 ? cur - 1 : -1,
        cc < SW - 1 ? cur + 1 : -1,
        cr > 0 ? cur - SW : -1,
        cr < SH - 1 ? cur + SW : -1,
      ];
      for (let k = 0; k < 4; k++) {
        const nb = nbrs[k];
        if (nb < 0 || bfsVis[nb] || isOutsideDomain[nb]) continue;
        if ((simProtected[nb] || isOsmDefense[nb]) && wl < simDefenseCrown[nb]) continue;
        // Permite paso de remanso por aliviadores/albardones angostos (<= +0,75 m), llenando solo donde Z < wl
        if (simZ[nb] <= wl + 0.75) {
          bfsVis[nb] = 1;
          bfsWL[nb] = wl;
          bfsQ[tail++] = nb;
          if (simZ[nb] < wl) {
            const d = wl - simZ[nb];
            if (d > simW[nb]) {
              const nbType = simType[nb];
              if (nbType !== 1 && nbType !== 4) {
                state.massBalance.riverInM3 += (d - simW[nb]) * cellAreaM2;
              }
              simW[nb] = d;
            }
          }
        }
      }
    }
  }

  // Al bajar el nivel de un río (incluso con lluvia previa), recalcular el equilibrio fluvial extramuros
  function reconcileRiverDrop() {
    const riseP = scaleToParanaRise(state.paranaScale);
    const riseS = scaleToSaladoRise(state.saladoScale);
    if (state.fallenMm <= 0.01) {
      resetWaterOnly();
      if (riseP > 0.01 || riseS > 0.01) applyRiverEquilibrium(riseP, riseS);
      updateMetrics();
      return;
    }
    // Con lluvia caída: limpiar cauces bajados y acotar agua fluvial extramuros al nuevo equilibrio + lámina pluvial local
    const rainCapM = Math.min(0.65, state.fallenMm * 0.001 * 1.35);
    for (let i = 0; i < S_N; i++) {
      const t = simType[i];
      if (isOutsideDomain[i]) {
        simW[i] = 0;
      } else if (t === 1) {
        simW[i] = riseP > 0.01 ? Math.max(0.0, simBaseP[i] + riseP - simZ[i]) : 0.0;
      } else if (t === 4) {
        const sr = (i / SW) | 0;
        simW[i] = riseS > 0.01 ? Math.max(0.0, saladoWaterLevelAtRow(sr, riseS) - simZ[i]) : 0.0;
      } else if (t === 0 && !simProtected[i] && simW[i] > rainCapM) {
        simW[i] = rainCapM;
      }
    }
    if (riseP > 0.01 || riseS > 0.01) {
      applyRiverEquilibrium(riseP, riseS);
    }
    updateMetrics();
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

    if ((!rainEnabled || state.fallenMm === 0) && (riseP > 0.01 || riseS > 0.01)) {
      applyRiverEquilibrium(riseP, riseS);
    }

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
        if (isOutsideDomain[i]) {
          simW[i] = 0;
          continue;
        }
        const t = simType[i];
        if (t === 1) {
          simW[i] = riseP > 0.01 ? Math.max(0.0, simBaseP[i] + riseP - simZ[i]) : 0.0;
          continue;
        }
        if (t === 4) {
          const sr = (i / SW) | 0;
          simW[i] = riseS > 0.01 ? Math.max(0.0, saladoWaterLevelAtRow(sr, riseS) - simZ[i]) : 0.0;
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
          const n0 = i - 1, n1 = i + 1, n2 = i - SW, n3 = i + SW;
          const n4 = i - SW - 1, n5 = i - SW + 1, n6 = i + SW - 1, n7 = i + SW + 1;

          let d0, d1, d2, d3, d4, d5, d6, d7;
          if (!nearBarrier[i]) {
            d0 = h - (simZ[n0] + simW[n0]);
            d1 = h - (simZ[n1] + simW[n1]);
            d2 = h - (simZ[n2] + simW[n2]);
            d3 = h - (simZ[n3] + simW[n3]);
            d4 = (h - (simZ[n4] + simW[n4])) * INV_SQRT2;
            d5 = (h - (simZ[n5] + simW[n5])) * INV_SQRT2;
            d6 = (h - (simZ[n6] + simW[n6])) * INV_SQRT2;
            d7 = (h - (simZ[n7] + simW[n7])) * INV_SQRT2;
          } else {
            const srcExt = !simProtected[i];
            const srcDef = isOsmDefense[i] === 1;
            d0 = ((srcExt && simProtected[n0]) || (!srcDef && isOsmDefense[n0])) && h < simDefenseCrown[n0] ? 0 : h - (simZ[n0] + simW[n0]);
            d1 = ((srcExt && simProtected[n1]) || (!srcDef && isOsmDefense[n1])) && h < simDefenseCrown[n1] ? 0 : h - (simZ[n1] + simW[n1]);
            d2 = ((srcExt && simProtected[n2]) || (!srcDef && isOsmDefense[n2])) && h < simDefenseCrown[n2] ? 0 : h - (simZ[n2] + simW[n2]);
            d3 = ((srcExt && simProtected[n3]) || (!srcDef && isOsmDefense[n3])) && h < simDefenseCrown[n3] ? 0 : h - (simZ[n3] + simW[n3]);
            d4 = ((srcExt && simProtected[n4]) || (!srcDef && isOsmDefense[n4])) && h < simDefenseCrown[n4] ? 0 : (h - (simZ[n4] + simW[n4])) * INV_SQRT2;
            d5 = ((srcExt && simProtected[n5]) || (!srcDef && isOsmDefense[n5])) && h < simDefenseCrown[n5] ? 0 : (h - (simZ[n5] + simW[n5])) * INV_SQRT2;
            d6 = ((srcExt && simProtected[n6]) || (!srcDef && isOsmDefense[n6])) && h < simDefenseCrown[n6] ? 0 : (h - (simZ[n6] + simW[n6])) * INV_SQRT2;
            d7 = ((srcExt && simProtected[n7]) || (!srcDef && isOsmDefense[n7])) && h < simDefenseCrown[n7] ? 0 : (h - (simZ[n7] + simW[n7])) * INV_SQRT2;
          }

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
        if (isOutsideDomain[i]) {
          if (simDW[i] > 0) state.massBalance.borderOutM3 += simDW[i] * cellAreaM2;
          simW[i] = 0;
          continue;
        }
        const t = simType[i];
        if (t === 1 || t === 4) {
          const dw = simDW[i];
          if (dw > 0) state.massBalance.riverOutM3 += dw * cellAreaM2;
          else if (dw < 0) state.massBalance.riverInM3 += -dw * cellAreaM2;
          if ((t === 1 && riseP <= 0.01) || (t === 4 && riseS <= 0.01)) {
            simW[i] = 0;
          }
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

  function getQuickSample(u, v) {
    const lon = cfg.lonMin + u * (cfg.lonMax - cfg.lonMin);
    const lat = cfg.latMax - v * (cfg.latMax - cfg.latMin);
    const elev = sampleHeightAtUV(u, v);
    const wM = sampleWaterAtUV(u, v);
    const wCm = Math.round(wM * 100);
    const prob = sampleProbAtUV(u, v);
    const px = Math.min(cfg.W - 1, Math.max(0, Math.round(u * (cfg.W - 1))));
    const py = Math.min(cfg.H - 1, Math.max(0, Math.round(v * (cfg.H - 1))));
    const idx = (py * cfg.W + px) * 4;
    const rId = layersRGBA[idx], cId = layersRGBA[idx + 1], binVal = layersRGBA[idx + 2];
    const acU16 = (acumRGBA[idx] << 8) | acumRGBA[idx + 1];
    const acVal = acU16 === 0 ? 0 : Math.pow(10, (acU16 / 65535.0) * 6.5);
    const sc = Math.min(SW - 1, Math.max(0, Math.round(u * (SW - 1))));
    const sr = Math.min(SH - 1, Math.max(0, Math.round(v * (SH - 1))));
    const si = sr * SW + sc;
    let zoneCat = "Extramuros sin defensa";
    if (isOutsideDomain[si]) zoneCat = "Margen Entre Ríos (fuera de dominio)";
    else if (cId === 7 || cId === 8) zoneCat = "Área de reservorio";
    else if (cId === 1 || cId === 2 || cId === 9 || cId === 10) zoneCat = "Cauce / laguna fluvial";
    else if (simProtected[si] || rId === 1) zoneCat = "Intramuros protegido";
    else if (rId === 2 || rId === 3) zoneCat = "Periurbano / transición";
    return { lon, lat, elev, wM, wCm, prob, rId, cId, binVal, acVal, zoneCat, protected: !!simProtected[si] };
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
    let pumpInfo = null;
    if (nearPump && nearPumpD < 0.75) {
      const meta = pumpMetaById.get(Number(nearPump.id)) || null;
      pumpInfo = {
        ...nearPump,
        distM: Math.round(nearPumpD * 1000),
        tipo: meta?.tipo || "movil",
        codigo: meta?.codigo || `#${nearPump.id}`,
        nombre: meta?.nombre || `Punto de bombeo móvil #${nearPump.id}`,
        caudal_m3h: meta?.caudal_m3h || null,
        caudal_m3s: meta?.caudal_m3s || null,
        bombas_ref: meta?.bombas_ref || null,
        reservorio: meta?.reservorio || null,
      };
    }

    return {
      u, v, ...base,
      placeName,
      nearPump: pumpInfo,
    };
  }

  function getOvertoppedDefenses() {
    const out = [];
    const tramos = Array.isArray(researchOverrides?.defensas?.tramos) ? researchOverrides.defensas.tramos : [];
    const riseP = scaleToParanaRise(state.paranaScale);
    const riseS = scaleToSaladoRise(state.saladoScale);
    if (riseP <= 0.01 && riseS <= 0.01) return out;
    const wlParanaRef = 11.50 + riseP;
    const wlSaladoRef = 11.45 + riseS;
    for (const tr of tramos) {
      if (tr.tipologia === "sin_defensa") continue;
      const crown = Number(tr.cota_coronamiento_m);
      if (!Number.isFinite(crown)) continue;
      const isWest = /oeste|a007|salado/i.test(tr.nombre || "");
      const riverWl = isWest ? wlSaladoRef : wlParanaRef;
      if (riverWl >= crown - 0.15) {
        out.push({
          nombre: tr.nombre,
          crownM: crown,
          riverWlM: Math.round(riverWl * 100) / 100,
          overtopped: riverWl >= crown,
        });
      }
    }
    return out;
  }

  function getActiveCriticalPoints() {
    const active = [];
    for (const pt of criticalPoints) {
      let triggered = false;
      let reason = "";
      if (pt.umbral_rio === "parana_santa_fe" && Number.isFinite(Number(pt.umbral_hidrometrico_m))) {
        if (state.paranaScale >= Number(pt.umbral_hidrometrico_m)) {
          triggered = true;
          reason = `Paraná >= ${Number(pt.umbral_hidrometrico_m).toFixed(2).replace(".", ",")} m`;
        }
      } else if (pt.umbral_rio === "salado_santo_tome" && Number.isFinite(Number(pt.umbral_hidrometrico_m))) {
        if (state.saladoScale >= Number(pt.umbral_hidrometrico_m)) {
          triggered = true;
          reason = `Salado >= ${Number(pt.umbral_hidrometrico_m).toFixed(2).replace(".", ",")} m`;
        }
      }
      if (!triggered && pt.umbral_lluvia_mm != null && Number.isFinite(Number(pt.umbral_lluvia_mm))) {
        if (state.fallenMm >= Number(pt.umbral_lluvia_mm)) {
          triggered = true;
          reason = `Lluvia >= ${Math.round(Number(pt.umbral_lluvia_mm))} mm`;
        }
      }
      if (triggered) {
        const wCm = Math.round(sampleWaterAtUV(pt.u, pt.v) * 100);
        active.push({ ...pt, reason, wCm });
      }
    }
    return active;
  }

  return {
    state,
    manualPumps,
    waterTexBytes,
    sampleHeightAtUV,
    sampleWaterAtUV,
    sampleProbAtUV,
    getQuickSample,
    updateWaterBytes,
    updateMetrics,
    resetWaterOnly,
    reconcileRiverDrop,
    dropLocalRain,
    addManualPump,
    clearManualPumps,
    stepSubsteps,
    advanceWall,
    getActiveCriticalPoints,
    getOvertoppedDefenses,
    getPointDiagnostics,
  };
}
