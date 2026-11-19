// Servicio de datos en vivo (INA + Open-Meteo) con fallback independiente por fuente hacia datos_en_vivo.json.

async function fetchWithTimeout(url, ms = 8500) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error("HTTP " + res.status);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

async function fetchINASeries(seriesId) {
  const now = new Date();
  const start = new Date(now.getTime() - 10 * 86400000).toISOString().slice(0, 10);
  const end = new Date(now.getTime() + 2 * 86400000).toISOString().slice(0, 10);
  const url = `https://alerta.ina.gob.ar/a5/obs/puntual/series/${seriesId}/observaciones?timestart=${start}&timeend=${end}`;
  const rows = await fetchWithTimeout(url, 8500);
  const valid = (Array.isArray(rows) ? rows : []).filter(
    r => r && r.valor !== null && r.valor !== undefined && Number.isFinite(Number(r.valor))
  );
  if (!valid.length) return null;
  valid.sort((a, b) => String(a.timestart || "").localeCompare(String(b.timestart || "")));
  const last = valid[valid.length - 1];
  const prev = valid.length >= 2 ? valid[valid.length - 2] : null;
  const val = Math.round(Number(last.valor) * 100) / 100;
  return {
    val,
    delta: prev ? Math.round((val - Number(prev.valor)) * 100) / 100 : 0,
    date: last.timestart || null,
    history: valid.slice(-7).map(r => ({
      fecha_utc: r.timestart,
      valor_m: Math.round(Number(r.valor) * 100) / 100,
    })),
  };
}

async function fetchOpenMeteo(weatherCfg) {
  const tz = encodeURIComponent(weatherCfg.timezone || "America/Argentina/Cordoba");
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${weatherCfg.lat}&longitude=${weatherCfg.lon}` +
    `&current=temperature_2m,precipitation,rain&hourly=precipitation,precipitation_probability` +
    `&past_days=1&forecast_days=2&timezone=${tz}`;
  const d = await fetchWithTimeout(url, 8000);
  const cur = d.current || {};
  const curHour = String(cur.time || "").slice(0, 13);
  const times = (d.hourly && d.hourly.time) || [];
  const precs = (d.hourly && d.hourly.precipitation) || [];
  const probs = (d.hourly && d.hourly.precipitation_probability) || [];
  const pastArr = [];
  let n24 = 0, n48 = 0, peak = 0, pmax = 0, fIdx = 0;

  for (let i = 0; i < times.length; i++) {
    const mm = Number(precs[i] || 0);
    const pr = Number(probs[i] || 0);
    if (curHour && String(times[i]).slice(0, 13) <= curHour) {
      pastArr.push(mm);
    } else {
      if (fIdx < 24) n24 += mm;
      if (fIdx < 48) {
        n48 += mm;
        if (mm > peak) peak = mm;
        if (pr > pmax) pmax = pr;
      }
      fIdx++;
    }
  }
  const past = pastArr.slice(-24).reduce((a, b) => a + b, 0);
  return {
    tempC: cur.temperature_2m !== undefined ? Number(cur.temperature_2m) : null,
    rainNow: Math.round(Number(cur.precipitation || 0) * 10) / 10,
    rain24h: Math.round(past * 10) / 10,
    forecast24h: Math.round(n24 * 10) / 10,
    forecast48h: Math.round(n48 * 10) / 10,
    peakHr: Math.round(peak * 10) / 10,
    probMax: Math.round(pmax),
    weatherDate: cur.time || null,
  };
}

export function createLiveState(regionCfg, embeddedCache = null) {
  const hydro = regionCfg.hydrometry;
  const st = {
    parana: hydro.parana_normal_m,
    paranaDelta: 0,
    paranaDate: null,
    paranaHistory: [],
    salado: hydro.salado_normal_m,
    saladoDelta: 0,
    saladoDate: null,
    saladoHistory: [],
    recreo: null,
    recreoDelta: 0,
    recreoDate: null,
    recreoHistory: [],
    tempC: null,
    rainNow: 0,
    rain24h: 0,
    forecast24h: 0,
    forecast48h: 0,
    peakHr: 0,
    probMax: 0,
    weatherDate: null,
    source: "loading", // loading | live | partial | cache | fallback
    sourcesDetail: { parana: "none", salado: "none", recreo: "none", weather: "none" },
    loadedOnce: false,
  };
  if (embeddedCache) {
    applyCacheToMissing(st, embeddedCache, { parana: false, salado: false, recreo: false, weather: false });
    st.source = "cache";
  }
  return st;
}

function clampRiver(v, lo, hi) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : null;
}

function applyCacheToMissing(state, cached, hasLive) {
  let usedCache = false;
  if (!cached) return false;
  const rios = cached.rios || {};
  if (!hasLive.parana && rios.parana_santa_fe && rios.parana_santa_fe.valor_m != null) {
    const v = clampRiver(rios.parana_santa_fe.valor_m, 2.0, 7.5);
    if (v !== null) {
      state.parana = v;
      state.paranaDelta = Number(rios.parana_santa_fe.delta_m || 0);
      state.paranaDate = rios.parana_santa_fe.fecha_utc || null;
      state.paranaHistory = rios.parana_santa_fe.ultimos_registros || [];
      state.sourcesDetail.parana = "cache";
      usedCache = true;
    }
  }
  if (!hasLive.salado && rios.salado_santo_tome && rios.salado_santo_tome.valor_m != null) {
    const v = clampRiver(rios.salado_santo_tome.valor_m, 2.0, 8.0);
    if (v !== null) {
      state.salado = v;
      state.saladoDelta = Number(rios.salado_santo_tome.delta_m || 0);
      state.saladoDate = rios.salado_santo_tome.fecha_utc || null;
      state.saladoHistory = rios.salado_santo_tome.ultimos_registros || [];
      state.sourcesDetail.salado = "cache";
      usedCache = true;
    }
  }
  if (!hasLive.recreo && rios.salado_recreo_rp70 && rios.salado_recreo_rp70.valor_m != null) {
    const v = clampRiver(rios.salado_recreo_rp70.valor_m, 0.0, 10.0);
    if (v !== null) {
      state.recreo = v;
      state.recreoDelta = Number(rios.salado_recreo_rp70.delta_m || 0);
      state.recreoDate = rios.salado_recreo_rp70.fecha_utc || null;
      state.recreoHistory = rios.salado_recreo_rp70.ultimos_registros || [];
      state.sourcesDetail.recreo = "cache";
      usedCache = true;
    }
  }
  if (!hasLive.weather && cached.clima) {
    const cl = cached.clima;
    state.tempC = cl.temperatura_c != null ? Number(cl.temperatura_c) : null;
    state.rainNow = Number(cl.lluvia_actual_mm || 0);
    state.rain24h = Number(cl.lluvia_ultimas_24h_mm || 0);
    state.forecast24h = Number(cl.pronostico_24h_mm || 0);
    state.forecast48h = Number(cl.pronostico_48h_mm || 0);
    state.peakHr = Number(cl.pico_horario_48h_mm || 0);
    state.probMax = Number(cl.prob_max_48h_pct || 0);
    state.weatherDate = cl.fecha_local || null;
    state.sourcesDetail.weather = "cache";
    usedCache = true;
  }
  return usedCache;
}

export async function refreshLiveData(state, regionCfg, embeddedCache = null) {
  const stations = Object.fromEntries(regionCfg.hydrometry.stations.map(s => [s.key, s]));
  const pId = stations.parana_santa_fe ? stations.parana_santa_fe.series_id : 30;
  const sId = stations.salado_santo_tome ? stations.salado_santo_tome.series_id : 3044;
  const rId = stations.salado_recreo_rp70 ? stations.salado_recreo_rp70.series_id : 103;

  const [pRes, sRes, rRes, wRes] = await Promise.allSettled([
    fetchINASeries(pId),
    fetchINASeries(sId),
    fetchINASeries(rId),
    fetchOpenMeteo(regionCfg.weather),
  ]);

  const hasLive = { parana: false, salado: false, recreo: false, weather: false };

  if (pRes.status === "fulfilled" && pRes.value) {
    state.parana = Math.max(2.0, Math.min(7.5, pRes.value.val));
    state.paranaDelta = pRes.value.delta;
    state.paranaDate = pRes.value.date;
    state.paranaHistory = pRes.value.history;
    state.sourcesDetail.parana = "live";
    hasLive.parana = true;
  }
  if (sRes.status === "fulfilled" && sRes.value) {
    state.salado = Math.max(2.0, Math.min(8.0, sRes.value.val));
    state.saladoDelta = sRes.value.delta;
    state.saladoDate = sRes.value.date;
    state.saladoHistory = sRes.value.history;
    state.sourcesDetail.salado = "live";
    hasLive.salado = true;
  }
  if (rRes.status === "fulfilled" && rRes.value) {
    state.recreo = rRes.value.val;
    state.recreoDelta = rRes.value.delta;
    state.recreoDate = rRes.value.date;
    state.recreoHistory = rRes.value.history;
    state.sourcesDetail.recreo = "live";
    hasLive.recreo = true;
  }
  if (wRes.status === "fulfilled" && wRes.value) {
    Object.assign(state, wRes.value);
    state.sourcesDetail.weather = "live";
    hasLive.weather = true;
  }

  const liveCount = Object.values(hasLive).filter(Boolean).length;
  let usedCache = false;

  // Fallback independiente por fuente faltante (corrige bug donde Open-Meteo OK ocultaba caída del INA)
  if (liveCount < 4) {
    let cached = embeddedCache;
    if (!cached && typeof window !== "undefined" && window.location.protocol !== "file:") {
      try {
        cached = await fetchWithTimeout("./datos_en_vivo.json?t=" + Date.now(), 5000);
      } catch (_) {
        cached = null;
      }
    }
    if (cached) {
      usedCache = applyCacheToMissing(state, cached, hasLive);
    }
  }

  if (liveCount === 4) state.source = "live";
  else if (liveCount > 0 && usedCache) state.source = "partial";
  else if (liveCount > 0) state.source = "partial";
  else if (usedCache) state.source = "cache";
  else state.source = "fallback";

  state.loadedOnce = true;
  return state;
}
