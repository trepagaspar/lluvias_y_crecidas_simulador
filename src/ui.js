// Controlador de UI "Cartographic Dark Telemetry":
// 3 zonas sin solapamiento, cero emojis, DOM 100% seguro contra XSS, deep-linking bidireccional y responsive móvil.
import { createIcon, createSparklineSVG, hydrateIcons } from "./icons.js";
import { el, fmtDelta, fmtInt, fmtNum, fmtShortDate } from "./format.js";
import { isRiverElevated } from "./sim-engine.js";
import { createStorySteps } from "./story.js";

const MODE_META = {
  sim: { title: "Simulador Hídrico", sub: "Ríos Paraná/Salado, tormenta y bombeo" },
  layers: { title: "Capas y Relieve 3D", sub: "Mapa base, drenaje, riesgo y topografía" },
  impact: { title: "Impacto y Diagnóstico", sub: "KPIs, alertas territoriales y ficha por sector" },
};

const RISK_NAMES = [
  "Fuera de dominio",
  "Intramuros protegido",
  "Defendida / periurbana",
  "Franja de transición",
  "Terraza baja fluvial",
  "Extramuros sin defensa",
];

const RISK_DESC = [
  "fuera de análisis",
  "intramuros protegido sobre terraza alta urbanizada",
  "área defendida o periurbana condicionada",
  "franja de transición topográfica",
  "terraza baja o franja de transición fluvial",
  "extramuros sin defensa (valle aluvial activo, bañados e islas)",
];

export function initUI({ cfg, regionCfg, places, sim, liveState, onRefreshLive, renderer }) {
  hydrateIcons(document);

  const $ = id => document.getElementById(id);

  const sidebar = $("sidebar");
  const drawerTitle = $("drawer-title");
  const drawerSub = $("drawer-sub");
  const toggleDrawerBtn = $("btn-toggle-drawer");
  const railBadge = $("rail-impact-badge");
  const toastEl = $("toast");

  const ui = {
    z: $("sl-z"),
    hs: $("sl-hs"),
    contours: $("chk-contours"),
    riskAlpha: $("sl-risk-alpha"),
    riskLayer: $("chk-risk-layer"),
    r1: $("chk-r1"),
    r2: $("chk-r2"),
    r3: $("chk-r3"),
    r4: $("chk-r4"),
    cityPumps: $("chk-city-pumps"),
    osmCanales: $("chk-osm-canales"),
    res: $("chk-res"),
    bin: $("chk-bin"),
    acflow: $("chk-acflow"),
    thresh: $("sl-thresh"),
    water: $("chk-water"),
    parks: $("chk-parks"),
    landfill: $("chk-landfill"),
    labels: $("chk-labels"),
    lightMode: $("chk-light-mode"),
    rain: $("sl-rain"),
    dur: $("sl-dur"),
    parana: $("sl-parana"),
    salado: $("sl-salado"),
    recreo: $("sl-recreo"),
  };

  let activeMode = "sim";
  let activeTool = "inspect";
  let uncertaintyMode = true;
  let storyIdx = -1;
  let toastTimer = null;

  function showToast(msg, ms = 2400) {
    toastEl.textContent = msg;
    toastEl.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove("show"), ms);
  }

  function setSidebarOpen(open) {
    sidebar.classList.toggle("collapsed", !open);
    toggleDrawerBtn.setAttribute("aria-expanded", String(open));
    const collapseBtn = $("btn-rail-collapse");
    collapseBtn.replaceChildren(createIcon(open ? "chevronLeft" : "chevronRight", 16));
    collapseBtn.title = open ? "Contraer panel" : "Expandir panel";
    collapseBtn.setAttribute("aria-label", collapseBtn.title);
    renderer.requestRender(true);
  }

  function setMode(mode, ensureOpen = true) {
    activeMode = mode;
    document.querySelectorAll("[data-mode]").forEach(btn => {
      const active = btn.dataset.mode === mode;
      btn.classList.toggle("active", active);
      btn.setAttribute("aria-selected", String(active));
    });
    for (const k of ["sim", "layers", "impact"]) {
      $("pane-" + k).classList.toggle("active", k === mode);
    }
    const meta = MODE_META[mode] || MODE_META.sim;
    drawerTitle.textContent = meta.title;
    drawerSub.textContent = meta.sub;
    if (ensureOpen && sidebar.classList.contains("collapsed")) setSidebarOpen(true);
  }

  document.querySelectorAll("[data-mode]").forEach(btn => {
    btn.addEventListener("click", () => {
      const target = btn.dataset.mode;
      if (target === activeMode && !sidebar.classList.contains("collapsed")) {
        setSidebarOpen(false);
      } else {
        setMode(target, true);
      }
    });
  });

  toggleDrawerBtn.addEventListener("click", () => setSidebarOpen(sidebar.classList.contains("collapsed")));
  $("btn-rail-collapse").addEventListener("click", () => setSidebarOpen(sidebar.classList.contains("collapsed")));
  $("btn-close-drawer").addEventListener("click", () => setSidebarOpen(false));

  // En móvil (<=920px), iniciar con el panel contraído para dejar el 3D despejado
  if (window.innerWidth <= 920) {
    setSidebarOpen(false);
  }

  // Visual state provider para el renderer WebGL2
  function getVisualState() {
    const rMask = !ui.riskLayer.checked
      ? 0
      : (ui.r1.checked ? 1 : 0) |
        (ui.r2.checked ? 2 : 0) |
        (ui.r3.checked ? 4 : 0) |
        (ui.r4.checked ? 8 : 0);
    return {
      zScale: parseFloat(ui.z.value),
      hsStrength: parseFloat(ui.hs.value) / 100.0,
      riskAlpha: parseFloat(ui.riskAlpha.value) / 100.0,
      riskMask: rMask,
      showBin: ui.bin.checked,
      showAcum: ui.acflow.checked,
      threshLog: parseFloat(ui.thresh.value),
      showWater: ui.water.checked,
      showParks: ui.parks.checked,
      showLandfill: ui.landfill.checked,
      showRes: ui.res.checked,
      showContours: ui.contours.checked,
      showCityPumps: ui.cityPumps.checked,
      showOsmLines: ui.osmCanales.checked,
      uncertaintyMode,
      lightMode: ui.lightMode.checked,
      showLabels: ui.labels.checked,
      sidebarOpen: !sidebar.classList.contains("collapsed"),
    };
  }

  // Semáforo hidrométrico
  function setParanaTag(node, val) {
    if (val < 5.30) { node.textContent = "Normal"; node.className = "badge badge-ok"; }
    else if (val < 5.70) { node.textContent = "Alerta"; node.className = "badge badge-warn"; }
    else { node.textContent = "Evacuación"; node.className = "badge badge-crit"; }
  }

  function setSaladoTag(node, val) {
    if (val < 4.70) { node.textContent = "Normal"; node.className = "badge badge-ok"; }
    else if (val < 6.00) { node.textContent = "Alerta"; node.className = "badge badge-warn"; }
    else { node.textContent = "Crítica"; node.className = "badge badge-crit"; }
  }

  function setRecreoTag(node, val) {
    if (!node) return;
    if (val < 3.30) { node.textContent = "Base"; node.className = "badge badge-ok"; }
    else if (val < 4.80) { node.textContent = "Aporte"; node.className = "badge badge-warn"; }
    else { node.textContent = "Crecida"; node.className = "badge badge-crit"; }
  }

  function clearActiveScenario() {
    document.querySelectorAll("[data-sc]").forEach(b => b.classList.remove("active"));
  }

  function updateSimBanner() {
    const banner = $("sim-banner");
    const detail = $("sim-banner-detail");
    if (!banner || !detail) return;
    const st = sim.state;
    const liveRec = liveState.recreo !== null && Number.isFinite(liveState.recreo) ? liveState.recreo : 2.90;
    const riverChanged =
      Math.abs(st.paranaScale - liveState.parana) > 0.08 ||
      Math.abs(st.saladoScale - liveState.salado) > 0.08 ||
      Math.abs(st.recreoScale - liveRec) > 0.15;
    const rainActive = st.fallenMm > 0.5 || st.targetMm > 0;
    const infraAltered = !st.cityPumpsActive || st.drainMode === "saturated" || sim.manualPumps.length > 0;
    const isSimulated = riverChanged || rainActive || infraAltered;

    banner.classList.toggle("hidden", !isSimulated);
    document.body.classList.toggle("sim-mode", isSimulated);
    if (!isSimulated) return;

    const tags = [];
    if (rainActive) tags.push(`Lluvia ${fmtInt(Math.max(st.fallenMm, st.targetMm))} mm`);
    if (riverChanged) tags.push(`Paraná ${fmtNum(st.paranaScale, 2)} m · Salado ${fmtNum(st.saladoScale, 2)} m`);
    if (!st.cityPumpsActive) tags.push("Bombeo apagado");
    if (st.drainMode === "saturated") tags.push("Drenaje saturado");
    detail.textContent = tags.join(" · ") || "Parámetros modificados respecto a telemetría INA";
  }

  function updateTextLabels() {
    $("val-z").textContent = ui.z.value + "×";
    $("val-hs").textContent = ui.hs.value + "%";
    $("val-risk-alpha").textContent = ui.riskAlpha.value + "%";
    const thVal = Math.round(Math.pow(10, parseFloat(ui.thresh.value)) / 50) * 50;
    $("val-thresh").textContent = fmtInt(thVal);
    $("thresh-wrap").classList.toggle("hidden", !ui.acflow.checked);

    sim.state.targetMm = parseFloat(ui.rain.value);
    sim.state.durationHr = parseFloat(ui.dur.value);
    sim.state.paranaScale = parseFloat(ui.parana.value);
    sim.state.saladoScale = parseFloat(ui.salado.value);
    if (ui.recreo) sim.state.recreoScale = parseFloat(ui.recreo.value);

    const rate = Math.round(sim.state.targetMm / Math.max(0.25, sim.state.durationHr));
    $("val-rain").textContent = fmtInt(sim.state.targetMm) + " mm";
    $("val-dur").textContent = `${fmtNum(sim.state.durationHr, 1)} h (${fmtInt(rate)} mm/h)`;
    $("val-parana").textContent = fmtNum(sim.state.paranaScale, 2) + " m";
    $("val-salado").textContent = fmtNum(sim.state.saladoScale, 2) + " m";
    if ($("val-recreo")) $("val-recreo").textContent = fmtNum(sim.state.recreoScale, 2) + " m";
    setParanaTag($("tag-parana"), sim.state.paranaScale);
    setSaladoTag($("tag-salado"), sim.state.saladoScale);
    setRecreoTag($("tag-recreo"), sim.state.recreoScale);

    if (!sim.state.running && sim.state.fallenMm === 0) {
      $("sim-mm").textContent = `0 / ${fmtInt(sim.state.targetMm)} mm`;
    }
    updateSimBanner();
  }

  function updateSimUI() {
    const st = sim.state;
    const isPausedMid = !st.running && st.fallenMm > 0 && st.fallenMm < st.targetMm;
    const labelText = st.running ? "Pausar" : isPausedMid ? "Continuar" : "Simular lluvia";
    const dockLabel = st.running ? "Pausar" : isPausedMid ? "Seguir" : "Simular";
    const iconName = st.running ? "pause" : "play";

    const panelPlay = $("btn-sim-play-panel");
    panelPlay.classList.toggle("running", st.running);
    panelPlay.replaceChildren(createIcon(iconName, 13), el("span", { text: labelText }));

    const dockPlay = $("btn-sim-play");
    dockPlay.classList.toggle("running", st.running);
    dockPlay.replaceChildren(createIcon(iconName, 12), el("span", { id: "btn-sim-play-lbl", text: dockLabel }));

    const pct = st.targetMm > 0 ? Math.min(100, (st.fallenMm / st.targetMm) * 100) : 0;
    $("sim-bar").style.width = pct.toFixed(1) + "%";
    $("sim-mm").textContent = `${fmtInt(st.fallenMm)} / ${fmtInt(st.targetMm)} mm`;

    let stText = "Listo";
    const riverHigh = isRiverElevated(st.paranaScale, st.saladoScale);
    if (st.running) {
      stText = st.fallenMm < st.targetMm ? "Lloviendo..." : sim.manualPumps.length > 0 ? "Bombeando..." : "Escurriendo...";
    } else if (riverHigh) {
      stText = st.fallenMm > 0
        ? "Lluvia + crecida"
        : `Ríos ${fmtNum(st.paranaScale, 2)} / ${fmtNum(st.saladoScale, 2)} m`;
    } else if (st.fallenMm > 0) {
      stText = "Completada";
    }
    $("sim-status").textContent = stText;

    $("kpi-ha").textContent = `${fmtInt(st.urbanFloodHa)} ha`;
    $("kpi-ext").textContent = `${fmtInt(st.extFloodHa)} ha`;
    $("kpi-res").textContent = `${fmtInt(st.resFillPct)}%`;
    $("kpi-max").textContent = `${fmtInt(st.maxUrbanCm)} cm`;
    $("i-acum").textContent = `${fmtInt(st.urbanFloodHa)} ha int. · ${fmtInt(st.extFloodHa)} ha ext.`;
    updateSimBanner();

    const activeCrit = sim.getActiveCriticalPoints ? sim.getActiveCriticalPoints() : [];
    const empWrap = $("emp-alerts-wrap");
    const empList = $("emp-alerts-list");
    if (empWrap && empList) {
      empWrap.classList.toggle("hidden", activeCrit.length === 0);
      empList.replaceChildren(
        ...activeCrit.map(pt =>
          el(
            "button",
            {
              type: "button",
              className: "emp-alert-item",
              onClick: () => {
                renderer.setPin({ u: pt.u, v: pt.v });
                renderer.flyTo(Number(pt.lon), Number(pt.lat), -0.50, 0.56, 6.5);
                updateInspector(pt.u, pt.v);
                showPointDiagnosis(pt.u, pt.v, pt.nombre, false);
              },
            },
            el(
              "div",
              { className: "emp-alert-top" },
              el("span", { text: pt.nombre }),
              el("span", { className: "emp-alert-tag tabular", text: pt.reason })
            ),
            el("div", { className: "emp-alert-desc", text: pt.efecto_operativo || "" })
          )
        )
      );
    }

    const totalHits = activeCrit.length;
    railBadge.textContent = totalHits > 99 ? "99+" : String(totalHits);
    railBadge.classList.toggle("hidden", totalHits === 0);

    const pumpBtn = $("btn-clear-pumps");
    $("pump-cnt").textContent = String(sim.manualPumps.length);
    pumpBtn.classList.toggle("hidden", sim.manualPumps.length === 0);
  }

  // Telemetría en vivo (con sparklines 7 días, Recreo RP70 y lluvia 24 h) — 100% DOM seguro
  function renderLiveBox() {
    const pTxt = fmtNum(liveState.parana, 2);
    const sTxt = fmtNum(liveState.salado, 2);
    $("sc-hoy-sub").textContent = `Paraná ${pTxt} · Salado ${sTxt}`;
    $("sc-rhoy-sub").textContent = `2 h · Ríos ${pTxt}/${sTxt}`;

    const list = $("live-rivers-list");
    const rows = [
      {
        name: "Paraná — Puerto SF",
        val: liveState.parana,
        delta: liveState.paranaDelta,
        hist: liveState.paranaHistory,
        alert: 5.30,
      },
      {
        name: "Salado — Sto. Tomé (remanso)",
        val: liveState.salado,
        delta: liveState.saladoDelta,
        hist: liveState.saladoHistory,
        alert: 4.70,
      },
    ];
    if (liveState.recreo !== null && Number.isFinite(liveState.recreo)) {
      rows.push({
        name: "Salado — Recreo RP 70 (cuenca)",
        val: liveState.recreo,
        delta: liveState.recreoDelta,
        hist: liveState.recreoHistory,
        alert: null,
      });
    }

    list.replaceChildren(
      ...rows.map(r =>
        el(
          "div",
          { className: "river-row" },
          el(
            "div",
            {},
            el("div", { className: "river-name", text: r.name }),
            el(
              "div",
              { className: "tabular" },
              el("span", { className: "river-val", text: `${fmtNum(r.val, 2)} m` }),
              el("span", { className: "river-delta", text: fmtDelta(r.delta) })
            )
          ),
          createSparklineSVG(r.hist, r.alert, 68, 20)
        )
      )
    );

    if (liveState.tempC !== null) {
      $("live-weather").textContent =
        `${fmtNum(liveState.tempC, 1)} °C · 24h: ${fmtNum(liveState.rain24h, 1)} mm · Prón. 48h: ${fmtNum(liveState.forecast48h, 1)} mm (${liveState.probMax}%)`;
    } else {
      $("live-weather").textContent = "Clima no disponible (modo offline)";
    }

    const dot = $("live-dot");
    dot.className =
      "status-dot" +
      (liveState.source === "live" || liveState.source === "cache"
        ? " ok"
        : liveState.source === "partial"
          ? " partial"
          : "");

    const dtStr = fmtShortDate(liveState.saladoDate || liveState.paranaDate);
    if (liveState.source === "live") {
      $("live-meta").textContent = `En vivo (INA + Open-Meteo)${dtStr ? " · reg. " + dtStr : ""}`;
    } else if (liveState.source === "partial") {
      $("live-meta").textContent = `En vivo + caché local (respaldo parcial)${dtStr ? " · " + dtStr : ""}`;
    } else if (liveState.source === "cache") {
      $("live-meta").textContent = `Caché verificado (datos_en_vivo.json)${dtStr ? " · " + dtStr : ""}`;
    } else {
      $("live-meta").textContent = "Sin conexión: valores base de referencia";
    }

    sim.state.antecedentRain24h = liveState.rain24h || 0;
    if (liveState.recreo !== null && Number.isFinite(liveState.recreo) && !sim.state.running && sim.state.fallenMm === 0) {
      sim.state.recreoScale = liveState.recreo;
      if (ui.recreo) ui.recreo.value = liveState.recreo.toFixed(2);
    }
    updateSimBanner();
  }

  // Inspector inferior (muestreo liviano sin iterar equipamiento/lugares en hover)
  function updateInspector(u, v) {
    const d = sim.getQuickSample(u, v);
    $("i-coord").textContent = `${fmtNum(d.lat, 4)}, ${fmtNum(d.lon, 4)}`;
    $("i-elev").textContent = `${fmtNum(d.elev, 1)} m`;
    if (uncertaintyMode) {
      $("i-water").textContent =
        d.prob >= 0.80 ? "Alta (>80%)" :
        d.prob >= 0.44 ? "Media" :
        d.prob >= 0.15 ? "Sensible" : "Bajo";
    } else {
      $("i-water").textContent = `${d.wCm} cm`;
    }
    $("i-risk").textContent = d.zoneCat || RISK_NAMES[d.rId] || "--";
  }

  // Diagnóstico en Modo 3 (Impacto) — 100% DOM seguro, sin XSS, sin solapamiento
  function showPointDiagnosis(u, v, forcedName = null, openImpactTab = true) {
    const d = sim.getPointDiagnostics(u, v, places, forcedName);
    $("diag-title").textContent = d.placeName;
    $("diag-clear").classList.remove("hidden");

    const parts = [
      el("div", {}, "Cota FABDEM: ", el("strong", { text: `${fmtNum(d.elev, 1)} m` }), ` (±0,6 m) · `, el("strong", { text: d.zoneCat || RISK_NAMES[d.rId] || "" })),
    ];

    if (d.cId === 7 || d.cId === 8) {
      parts.push(el("div", { text: "Sector perteneciente a reservorio o cuenco de retención." }));
    } else if (d.cId === 1 || d.cId === 2 || d.cId === 9 || d.cId === 10) {
      parts.push(el("div", { text: "Pertenece al cauce o laguna fluvial." }));
    } else if (d.binVal > 128) {
      parts.push(el("div", { text: `Corredor de escurrimiento natural (acum. ~${fmtInt(d.acVal)} cel.).` }));
    }

    if (uncertaintyMode) {
      if (d.prob >= 0.80) {
        const lo = Math.max(15, d.wCm - 20), hi = d.wCm + 25;
        parts.push(el("div", {}, "Confianza ", el("strong", { text: "alta (>80%)" }), `: bajo estructural · rango orientativo ~${lo}–${hi} cm.`));
      } else if (d.prob >= 0.44) {
        const lo = Math.max(0, d.wCm - 15), hi = d.wCm + 20;
        parts.push(el("div", {}, "Probabilidad ", el("strong", { text: "media (40–80%)" }), `: rango orientativo ~${lo}–${hi} cm (sensible a desagües u obras locales).`));
      } else if (d.prob >= 0.15) {
        parts.push(el("div", {}, "Franja ", el("strong", { text: "sensible (±0,6 m FABDEM)" }), ": el modelo marca seco, pero el terreno está próximo a la cota de agua vecina; requiere verificación en campo."));
      } else if (sim.state.fallenMm > 0 || isRiverElevated(sim.state.paranaScale, sim.state.saladoScale)) {
        parts.push(el("div", { text: "Baja probabilidad de anegamiento (< 15%) en el escenario actual." }));
      }
    } else {
      if (d.wCm >= 40) parts.push(el("div", {}, "Lámina estimada: ", el("strong", { text: `${d.wCm} cm` }), " (inundación profunda, orientativa)."));
      else if (d.wCm >= 15) parts.push(el("div", {}, "Lámina estimada: ", el("strong", { text: `${d.wCm} cm` }), " (anegamiento medio, orientativo)."));
      else if (d.wCm >= 4) parts.push(el("div", {}, "Encharcamiento somero estimado: ", el("strong", { text: `${d.wCm} cm` }), "."));
      else if (sim.state.fallenMm > 0 || isRiverElevated(sim.state.paranaScale, sim.state.saladoScale)) {
        parts.push(el("div", { text: "Sector seco (< 4 cm) en el escenario actual." }));
      }
    }

    if (d.nearPump) {
      const p = d.nearPump;
      const isFixed = p.tipo === "fija";
      const capTxt = p.caudal_m3h
        ? ` · cap. ref. ${fmtInt(p.caudal_m3h)} m³/h (${fmtNum(p.caudal_m3s, 1)} m³/s)`
        : "";
      const eqTxt = p.bombas_ref ? ` · ${p.bombas_ref}` : "";
      parts.push(
        el(
          "div",
          {},
          isFixed ? "Estación fija cercana: " : "Bombeo móvil cercano: ",
          el("strong", { text: isFixed ? `${p.codigo} — ${p.nombre}` : p.nombre }),
          ` (a ${fmtInt(p.distM)} m · ${sim.state.cityPumpsActive ? "activa" : "apagada"}${capTxt}${eqTxt}).`
        )
      );
    }

    const over = sim.getOvertoppedDefenses ? sim.getOvertoppedDefenses() : [];
    if (over.length > 0) {
      const ovTxt = over
        .map(o => `${o.nombre} (río ${fmtNum(o.riverWlM, 2)} m vs coronamiento ${fmtNum(o.crownM, 2)} m)`)
        .join("; ");
      parts.push(el("div", {}, el("strong", { text: "Alerta de sobrepaso / revancha crítica: " }), ovTxt));
    }

    $("diag-body").replaceChildren(...parts);
    if (openImpactTab) setMode("impact", true);
  }

  function clearDiagnosis() {
    renderer.setPin(null);
    $("diag-title").textContent = "Diagnóstico por sector";
    $("diag-clear").classList.add("hidden");
    $("diag-body").textContent =
      "Hacé clic en cualquier punto del mapa 3D para inspeccionar cotas, agua simulada y bombeo cercano.";
  }

  $("diag-clear").addEventListener("click", clearDiagnosis);

  // Acciones de simulación coherentes
  function setDrainMode(mode) {
    sim.state.drainMode = mode === "saturated" ? "saturated" : "partial";
    document.querySelectorAll("[data-drain]").forEach(b => b.classList.toggle("active", b.dataset.drain === sim.state.drainMode));
  }

  function setCityPumpsActive(active) {
    sim.state.cityPumpsActive = !!active;
    document.querySelectorAll("[data-cpump]").forEach(b =>
      b.classList.toggle("active", (b.dataset.cpump === "on") === sim.state.cityPumpsActive)
    );
    if (
      sim.state.cityPumpsActive &&
      !sim.state.running &&
      (sim.state.fallenMm > 0 || isRiverElevated(sim.state.paranaScale, sim.state.saladoScale))
    ) {
      sim.state.pumpSettle = 90;
    }
    // Al apagar las bombas NO se borra la lluvia ni se reinicia: simplemente dejan de extraer
    renderer.requestRender();
    updateSimUI();
  }

  function setStormProfile(profile) {
    sim.state.stormProfile = profile === "convective" ? "convective" : "uniform";
    document.querySelectorAll("[data-profile]").forEach(b =>
      b.classList.toggle("active", b.dataset.profile === sim.state.stormProfile)
    );
  }

  function setSoilMode(mode) {
    const valid = ["auto", "dry", "wet", "saturated"];
    sim.state.soilMode = valid.includes(mode) ? mode : "auto";
    document.querySelectorAll("[data-soil]").forEach(b =>
      b.classList.toggle("active", b.dataset.soil === sim.state.soilMode)
    );
  }

  function resetAll() {
    sim.state.running = false;
    sim.state.riverSettle = 0;
    sim.state.pumpSettle = 0;
    clearActiveScenario();
    sim.clearManualPumps();
    clearDiagnosis();
    ui.parana.value = cfg.PARANA_NORMAL.toFixed(2);
    ui.salado.value = cfg.SALADO_NORMAL.toFixed(2);
    if (ui.recreo) ui.recreo.value = "2.90";
    ui.rain.value = "0";
    ui.dur.value = "2";
    setDrainMode("partial");
    setStormProfile("uniform");
    setSoilMode("auto");
    sim.state.cityPumpsActive = true;
    document.querySelectorAll("[data-cpump]").forEach(b => b.classList.toggle("active", b.dataset.cpump === "on"));
    lastP = cfg.PARANA_NORMAL;
    lastS = cfg.SALADO_NORMAL;
    lastR = 2.90;
    sim.resetWaterOnly();
    updateTextLabels();
    sim.updateMetrics();
    renderer.uploadWaterTexture();
    updateSimUI();
    updateInspector(0.5, 0.5);
    renderer.requestRender();
  }

  function applyCustomScenario({
    rain = 0,
    dur = 2.0,
    parana = cfg.PARANA_NORMAL,
    salado = cfg.SALADO_NORMAL,
    recreo = null,
    drainMode = "partial",
    stormProfile = "uniform",
    runRain = false,
    settleRiverSubsteps = 0,
    preRunSubsteps = 0,
  }) {
    sim.state.running = false;
    sim.state.riverSettle = 0;
    sim.state.pumpSettle = 0;
    sim.resetWaterOnly();
    ui.rain.value = String(rain);
    ui.dur.value = String(dur);
    ui.parana.value = Number(parana).toFixed(2);
    ui.salado.value = Number(salado).toFixed(2);
    const recVal = recreo !== null && Number.isFinite(Number(recreo))
      ? Number(recreo)
      : (liveState.recreo !== null && Number.isFinite(liveState.recreo) ? liveState.recreo : 2.90);
    if (ui.recreo) ui.recreo.value = recVal.toFixed(2);
    setDrainMode(drainMode);
    setStormProfile(stormProfile);
    updateTextLabels();
    lastP = sim.state.paranaScale;
    lastS = sim.state.saladoScale;
    lastR = sim.state.recreoScale;

    if (settleRiverSubsteps > 0) {
      sim.stepSubsteps(settleRiverSubsteps, false);
      renderer.uploadWaterTexture();
    } else if (preRunSubsteps > 0) {
      sim.stepSubsteps(preRunSubsteps, true);
      renderer.uploadWaterTexture();
    } else {
      if (isRiverElevated(sim.state.paranaScale, sim.state.saladoScale)) sim.state.riverSettle = 18;
      if (runRain) sim.state.running = true;
    }
    updateSimUI();
    renderer.requestRender();
  }

  // Escenarios anclados a recurrencias hidrológicas (IDF Santa Fe / INA)
  function triggerScenario(sc, changeCamera = true) {
    document.querySelectorAll("[data-sc]").forEach(b => b.classList.toggle("active", b.dataset.sc === sc));
    const liveRec = liveState.recreo !== null && Number.isFinite(liveState.recreo) ? liveState.recreo : 2.90;
    if (sc === "hoy") {
      if (changeCamera) renderer.setPreset("top");
      sim.state.cityPumpsActive = true;
      document.querySelectorAll("[data-cpump]").forEach(b => b.classList.toggle("active", b.dataset.cpump === "on"));
      sim.clearManualPumps();
      applyCustomScenario({
        rain: 0,
        dur: 2.0,
        parana: liveState.parana,
        salado: liveState.salado,
        recreo: liveRec,
        drainMode: "partial",
      });
    } else if (sc === "tr5" || sc === "rain_hoy") {
      applyCustomScenario({
        rain: 65,
        dur: 2.0,
        parana: liveState.parana,
        salado: liveState.salado,
        recreo: liveRec,
        drainMode: "partial",
        stormProfile: "uniform",
        runRain: true,
      });
    } else if (sc === "tr10" || sc === "rain90") {
      applyCustomScenario({
        rain: 95,
        dur: 2.0,
        parana: cfg.PARANA_NORMAL,
        salado: cfg.SALADO_NORMAL,
        recreo: 2.90,
        drainMode: "partial",
        stormProfile: "convective",
        runRain: true,
      });
    } else if (sc === "tr50" || sc === "combo") {
      if (changeCamera) renderer.setPreset("cap2");
      applyCustomScenario({
        rain: 140,
        dur: 2.5,
        parana: 6.40,
        salado: 6.50,
        recreo: 4.60,
        drainMode: "saturated",
        stormProfile: "convective",
        runRain: true,
      });
    }
  }

  document.querySelectorAll("[data-sc]").forEach(btn => {
    btn.addEventListener("click", () => triggerScenario(btn.dataset.sc, true));
  });

  // Listeners de sliders y checkboxes
  Object.values(ui).forEach(input => {
    input.addEventListener("input", () => {
      updateTextLabels();
      renderer.requestRender(input === ui.z || input === ui.labels || input === ui.res);
    });
  });

  ui.riskLayer.addEventListener("change", () => {
    if (ui.riskLayer.checked && !ui.r1.checked && !ui.r2.checked && !ui.r3.checked && !ui.r4.checked) {
      ui.r1.checked = ui.r2.checked = ui.r3.checked = ui.r4.checked = true;
    }
    renderer.requestRender();
  });

  [ui.r1, ui.r2, ui.r3, ui.r4].forEach(chk => {
    chk.addEventListener("change", () => {
      const anyChecked = ui.r1.checked || ui.r2.checked || ui.r3.checked || ui.r4.checked;
      if (anyChecked && !ui.riskLayer.checked) ui.riskLayer.checked = true;
      else if (!anyChecked) ui.riskLayer.checked = false;
      renderer.requestRender();
    });
  });

  ui.lightMode.addEventListener("change", () => {
    renderer.setLightMode(ui.lightMode.checked);
  });

  let lastP = parseFloat(ui.parana.value);
  let lastS = parseFloat(ui.salado.value);
  let lastR = ui.recreo ? parseFloat(ui.recreo.value) : 2.90;

  function onRiverManualMove(prevP, prevS, prevR) {
    clearActiveScenario();
    const lowered =
      sim.state.paranaScale < prevP ||
      sim.state.saladoScale < prevS ||
      sim.state.recreoScale < prevR;
    if (lowered && sim.reconcileRiverDrop) {
      sim.reconcileRiverDrop();
      renderer.uploadWaterTexture();
    }
    sim.state.riverSettle = 18;
    updateSimUI();
    renderer.requestRender();
  }

  ui.parana.addEventListener("input", () => {
    const p = lastP; lastP = parseFloat(ui.parana.value);
    onRiverManualMove(p, lastS, lastR);
  });
  ui.salado.addEventListener("input", () => {
    const s = lastS; lastS = parseFloat(ui.salado.value);
    onRiverManualMove(lastP, s, lastR);
  });
  if (ui.recreo) {
    ui.recreo.addEventListener("input", () => {
      const r = lastR; lastR = parseFloat(ui.recreo.value);
      onRiverManualMove(lastP, lastS, r);
    });
  }
  ui.rain.addEventListener("input", clearActiveScenario);
  ui.dur.addEventListener("input", clearActiveScenario);

  if ($("btn-back-live")) {
    $("btn-back-live").addEventListener("click", () => {
      triggerScenario("hoy", false);
      showToast("Escenario restaurado a niveles reales del INA.");
    });
  }

  document.querySelectorAll("[data-drain]").forEach(btn =>
    btn.addEventListener("click", () => { clearActiveScenario(); setDrainMode(btn.dataset.drain); })
  );
  document.querySelectorAll("[data-cpump]").forEach(btn =>
    btn.addEventListener("click", () => setCityPumpsActive(btn.dataset.cpump === "on"))
  );
  document.querySelectorAll("[data-profile]").forEach(btn =>
    btn.addEventListener("click", () => setStormProfile(btn.dataset.profile))
  );
  document.querySelectorAll("[data-soil]").forEach(btn =>
    btn.addEventListener("click", () => setSoilMode(btn.dataset.soil))
  );
  document.querySelectorAll("[data-wvis]").forEach(btn =>
    btn.addEventListener("click", () => {
      uncertaintyMode = btn.dataset.wvis !== "depth";
      document.querySelectorAll("[data-wvis]").forEach(b =>
        b.classList.toggle("active", (b.dataset.wvis !== "depth") === uncertaintyMode)
      );
      const pin = renderer.getPin();
      if (pin) {
        updateInspector(pin.u, pin.v);
        showPointDiagnosis(pin.u, pin.v, null, false);
      }
      renderer.requestRender();
    })
  );

  function togglePlay() {
    // Si lluvia es 0 mm (ej. desde "Ríos hoy"), proponer 90 mm automáticamente para que el botón siempre responda
    if (sim.state.targetMm <= 0 && !sim.state.running) {
      ui.rain.value = "90";
      updateTextLabels();
      clearActiveScenario();
      showToast("Lluvia ajustada a 90 mm para iniciar tormenta.");
    }
    if (sim.state.fallenMm >= sim.state.targetMm && !sim.state.running) {
      sim.resetWaterOnly();
      if (isRiverElevated(sim.state.paranaScale, sim.state.saladoScale)) sim.state.riverSettle = 24;
    }
    sim.state.running = !sim.state.running;
    updateSimUI();
    renderer.requestRender();
  }

  $("btn-sim-play").addEventListener("click", togglePlay);
  $("btn-sim-play-panel").addEventListener("click", togglePlay);
  $("btn-sim-reset").addEventListener("click", resetAll);
  $("btn-sim-reset-panel").addEventListener("click", resetAll);

  // Botones de telemetría en vivo
  $("btn-refresh-live").addEventListener("click", async () => {
    $("live-meta").textContent = "Actualizando desde INA y Open-Meteo...";
    await onRefreshLive(true);
    showToast("Datos hidrometeorológicos actualizados.");
  });

  $("btn-load-forecast").addEventListener("click", () => {
    const mm = Math.round(liveState.forecast48h);
    ui.parana.value = liveState.parana.toFixed(2);
    ui.salado.value = liveState.salado.toFixed(2);
    lastP = liveState.parana;
    lastS = liveState.salado;
    if (mm < 2) {
      showToast(`Pronóstico 48 h seco (${fmtNum(liveState.forecast48h, 1)} mm). Ajustá lluvia manual.`);
      updateTextLabels();
      return;
    }
    clearActiveScenario();
    applyCustomScenario({
      rain: Math.min(250, Math.max(5, Math.round(mm / 5) * 5)),
      dur: mm >= 60 ? 3.0 : 1.5,
      parana: liveState.parana,
      salado: liveState.salado,
      drainMode: "partial",
      runRain: true,
    });
  });

  // Herramientas sobre el 3D (dock)
  document.querySelectorAll("[data-tool]").forEach(btn => {
    btn.addEventListener("click", () => {
      activeTool = btn.dataset.tool;
      document.querySelectorAll("[data-tool]").forEach(b => b.classList.toggle("active", b === btn));
      $("glcanvas").classList.toggle("tool-mode", activeTool !== "inspect");
      if (activeTool === "rain") showToast("Clic en el 3D para descargar chaparrón (+55 mm).");
      else if (activeTool === "pump") showToast("Clic en zona anegada para colocar bomba (máx. 5).");
    });
  });

  $("btn-clear-pumps").addEventListener("click", () => {
    sim.clearManualPumps();
    updateSimUI();
    renderer.requestRender();
  });

  // Basemaps con atribución y cancelación
  function setBasemap(mode) {
    const valid = ["relief", "streets", "sat"];
    const m = valid.includes(mode) ? mode : "sat";
    document.querySelectorAll("[data-base]").forEach(b => b.classList.toggle("active", b.dataset.base === m));
    renderer.loadOnlineBasemap(m, res => {
      $("basemap-status").textContent = res.status;
      const attrEl = $("basemap-attr");
      attrEl.textContent = res.attribution || "";
      attrEl.classList.toggle("hidden", !res.attribution);
      if (!res.ok) {
        document.querySelectorAll("[data-base]").forEach(b => b.classList.toggle("active", b.dataset.base === "relief"));
      }
    });
  }

  document.querySelectorAll("[data-base]").forEach(btn => {
    btn.addEventListener("click", () => setBasemap(btn.dataset.base));
  });

  // Presets de cámara (desktop buttons + mobile select sincronizados)
  function syncPresetUI(name) {
    document.querySelectorAll("[data-preset]").forEach(b => b.classList.toggle("active", b.dataset.preset === name));
    $("preset-select").value = name;
  }
  document.querySelectorAll("[data-preset]").forEach(btn =>
    btn.addEventListener("click", () => renderer.setPreset(btn.dataset.preset))
  );
  $("preset-select").addEventListener("change", e => renderer.setPreset(e.target.value));

  // Buscador de barrios
  const datalist = $("barrios-list");
  places.forEach(p => datalist.appendChild(el("option", { value: p.name })));

  const searchInput = $("search-place");
  function jumpToPlace(name) {
    const q = String(name || "").trim().toLowerCase();
    if (!q) return;
    const p =
      places.find(x => x.name.toLowerCase() === q) ||
      places.find(x => x.name.toLowerCase().includes(q));
    if (!p) return;
    const [, , u, v] = renderer.lonLatToWorldXZ(p.lon, p.lat);
    renderer.setPin({ u, v });
    renderer.flyTo(p.lon, p.lat, -0.55, 0.56, 6.2);
    updateInspector(u, v);
    showPointDiagnosis(u, v, p.name, true);
    searchInput.blur();
  }
  searchInput.addEventListener("change", e => jumpToPlace(e.target.value));
  searchInput.addEventListener("keydown", e => { if (e.key === "Enter") jumpToPlace(e.target.value); });

  // Leyenda oscura colapsable
  const legendPop = $("legend-popover");
  const legendBtn = $("btn-legend");
  function setLegendOpen(open) {
    legendPop.classList.toggle("hidden", !open);
    legendBtn.setAttribute("aria-expanded", String(open));
    legendBtn.classList.toggle("active", open);
  }
  legendBtn.addEventListener("click", () => setLegendOpen(legendPop.classList.contains("hidden")));
  $("btn-legend-close").addEventListener("click", () => setLegendOpen(false));

  // Recorrido guiado (5 pasos) y Ayuda
  const tourPop = $("tour-popover");
  const storySteps = createStorySteps({
    cfg,
    liveState,
    sim,
    renderer,
    actions: { resetAll, applyCustomScenario },
  });

  function showGuide() {
    storyIdx = -1;
    $("tour-title").textContent = "Guía rápida";
    $("tour-body").replaceChildren(
      el(
        "ol",
        {},
        el("li", {}, "Usá el panel izquierdo para ajustar las escalas del ", el("strong", { text: "Paraná" }), ", ", el("strong", { text: "Salado" }), " y la ", el("strong", { text: "lluvia" }), "."),
        el("li", {}, "Alterná entre ", el("strong", { text: "Simular" }), ", ", el("strong", { text: "Capas" }), " e ", el("strong", { text: "Impacto" }), " desde la barra vertical izquierda."),
        el("li", {}, "Hacé clic en el terreno para ver el diagnóstico o probá las herramientas ", el("strong", { text: "Lluvia" }), " y ", el("strong", { text: "Bomba" }), " del dock inferior.")
      )
    );
    $("tour-foot").replaceChildren(
      el("button", { type: "button", onClick: () => showStory(0) }, createIcon("book", 13), "Iniciar recorrido"),
      el("button", { type: "button", className: "btn-primary", text: "Entendido", onClick: () => tourPop.classList.add("hidden") })
    );
    tourPop.classList.remove("hidden");
  }

  function showStory(idx) {
    storyIdx = idx;
    const st = storySteps[idx];
    $("tour-title").textContent = st.getTitle ? st.getTitle() : st.title;
    $("tour-body").replaceChildren(el("p", { style: "margin:0;", text: st.getText ? st.getText() : st.text }));
    $("tour-foot").replaceChildren(
      el(
        "button",
        { type: "button", disabled: idx === 0, onClick: () => { if (storyIdx > 0) showStory(storyIdx - 1); } },
        createIcon("chevronLeft", 13),
        "Anterior"
      ),
      el(
        "button",
        {
          type: "button",
          className: "btn-primary",
          onClick: () => {
            if (storyIdx < storySteps.length - 1) showStory(storyIdx + 1);
            else tourPop.classList.add("hidden");
          },
        },
        idx === storySteps.length - 1 ? "Finalizar" : "Siguiente",
        idx === storySteps.length - 1 ? createIcon("check", 13) : createIcon("chevronRight", 13)
      )
    );
    tourPop.classList.remove("hidden");
    st.action();
  }

  $("tour-close").addEventListener("click", () => tourPop.classList.add("hidden"));
  $("btn-story").addEventListener("click", () => showStory(0));
  $("btn-help").addEventListener("click", () => {
    if (tourPop.classList.contains("hidden") || storyIdx >= 0) showGuide();
    else tourPop.classList.add("hidden");
  });

  // Captura PNG (sin preserveDrawingBuffer, renderNow() sincrónico)
  $("btn-shot").addEventListener("click", () => {
    const dataUrl = renderer.capturePNG();
    const a = document.createElement("a");
    a.download = "simulador_santa_fe_3d.png";
    a.href = dataUrl;
    a.click();
    showToast("Captura PNG descargada.");
  });

  // Deep-linking bidireccional ("Compartir escenario")
  function buildShareURL() {
    const url = new URL(window.location.href);
    const p = url.searchParams;
    p.set("vista", renderer.getCurrentPreset());
    p.set("parana", sim.state.paranaScale.toFixed(2));
    p.set("salado", sim.state.saladoScale.toFixed(2));
    p.set("lluvia", String(Math.round(sim.state.targetMm)));
    p.set("duracion", sim.state.durationHr.toFixed(1));
    if (sim.state.drainMode === "saturated") p.set("saturado", "1"); else p.delete("saturado");
    if (!sim.state.cityPumpsActive) p.set("bombeo", "0"); else p.delete("bombeo");
    if (sim.state.stormProfile === "convective") p.set("perfil", "convective"); else p.delete("perfil");
    if (sim.state.soilMode !== "auto") p.set("suelo", sim.state.soilMode); else p.delete("suelo");
    if (!uncertaintyMode) p.set("vis", "depth"); else p.delete("vis");
    p.delete("paso");
    return url.toString();
  }

  $("btn-share").addEventListener("click", async () => {
    const shareUrl = buildShareURL();
    try {
      window.history.replaceState(null, "", shareUrl);
    } catch (_) { /* file:// */ }
    try {
      await navigator.clipboard.writeText(shareUrl);
      showToast("Enlace del escenario copiado al portapapeles.");
    } catch (_) {
      showToast("URL actualizada en la barra de direcciones.");
    }
  });

  // Escape global para cerrar popovers o limpiar pin
  window.addEventListener("keydown", e => {
    if (e.key === "Escape") {
      if (!legendPop.classList.contains("hidden")) setLegendOpen(false);
      else if (!tourPop.classList.contains("hidden")) tourPop.classList.add("hidden");
      else if (renderer.getPin()) clearDiagnosis();
    }
  });

  // Interacción sobre el terreno 3D
  function handleTerrainClick(hit) {
    if (!hit) {
      if (activeTool === "inspect") clearDiagnosis();
      return;
    }
    if (activeTool === "rain") {
      sim.dropLocalRain(hit.u, hit.v, 55);
      renderer.uploadWaterTexture();
      updateInspector(hit.u, hit.v);
      updateSimUI();
      renderer.requestRender();
    } else if (activeTool === "pump") {
      sim.addManualPump(hit.u, hit.v);
      updateSimUI();
      renderer.requestRender();
    } else {
      renderer.setPin(hit);
      updateInspector(hit.u, hit.v);
      showPointDiagnosis(hit.u, hit.v, null, true);
    }
  }

  // Inicialización desde query params
  function applyURLParams(params) {
    renderer.setPreset(params.get("vista") || "top", true);
    if (params.get("saturado") === "1") setDrainMode("saturated");
    if (params.get("bombeo") === "0") {
      sim.state.cityPumpsActive = false;
      document.querySelectorAll("[data-cpump]").forEach(b => b.classList.toggle("active", b.dataset.cpump === "off"));
    }
    if (params.get("perfil") === "convective") setStormProfile("convective");
    if (params.has("suelo")) setSoilMode(params.get("suelo"));
    if (params.get("vis") === "depth") {
      uncertaintyMode = false;
      document.querySelectorAll("[data-wvis]").forEach(b =>
        b.classList.toggle("active", b.dataset.wvis === "depth")
      );
    }
    if (params.has("duracion")) {
      const d = parseFloat(params.get("duracion"));
      if (Number.isFinite(d)) ui.dur.value = String(Math.max(0.5, Math.min(6, d)));
    }
    if (params.has("parana")) {
      const v = parseFloat(params.get("parana"));
      if (Number.isFinite(v)) ui.parana.value = Math.max(2.0, Math.min(7.5, v)).toFixed(2);
    }
    if (params.has("salado")) {
      const v = parseFloat(params.get("salado"));
      if (Number.isFinite(v)) ui.salado.value = Math.max(2.0, Math.min(8.0, v)).toFixed(2);
    }
    if (params.has("recreo") && ui.recreo) {
      const v = parseFloat(params.get("recreo"));
      if (Number.isFinite(v)) ui.recreo.value = Math.max(0.5, Math.min(7.5, v)).toFixed(2);
    }
    if (params.has("lluvia")) {
      const v = parseFloat(params.get("lluvia"));
      if (Number.isFinite(v)) ui.rain.value = String(Math.max(0, Math.min(250, v)));
    }

    const hasCustom = params.has("parana") || params.has("salado") || params.has("recreo") || params.has("lluvia");
    if (hasCustom) {
      clearActiveScenario();
      updateTextLabels();
      lastP = sim.state.paranaScale;
      lastS = sim.state.saladoScale;
      lastR = sim.state.recreoScale;
      const hasRain = sim.state.targetMm > 0 && params.has("lluvia");
      const substeps = hasRain
        ? Math.max(280, Math.ceil((sim.state.durationHr + 1.5) / 0.015))
        : 240;
      sim.stepSubsteps(substeps, hasRain);
      renderer.uploadWaterTexture();
      updateSimUI();
    } else {
      ui.parana.value = liveState.parana.toFixed(2);
      ui.salado.value = liveState.salado.toFixed(2);
      if (ui.recreo && liveState.recreo !== null && Number.isFinite(liveState.recreo)) {
        ui.recreo.value = liveState.recreo.toFixed(2);
      }
      ui.rain.value = "0";
      updateTextLabels();
      lastP = sim.state.paranaScale;
      lastS = sim.state.saladoScale;
      lastR = sim.state.recreoScale;
      sim.stepSubsteps(210, false);
      renderer.uploadWaterTexture();
      updateSimUI();
    }

    if (params.has("paso")) {
      const s = parseInt(params.get("paso"), 10);
      if (s >= 0 && s < storySteps.length) {
        showStory(s);
        renderer.setPreset(renderer.getCurrentPreset(), true);
      }
    }
    return { hasCustom, hasStep: params.has("paso") };
  }

  function applyLiveRiversIfIdle() {
    const liveRec = liveState.recreo !== null && Number.isFinite(liveState.recreo) ? liveState.recreo : 2.90;
    const changed =
      Math.abs(sim.state.paranaScale - liveState.parana) > 0.02 ||
      Math.abs(sim.state.saladoScale - liveState.salado) > 0.02 ||
      Math.abs(sim.state.recreoScale - liveRec) > 0.05;
    ui.parana.value = liveState.parana.toFixed(2);
    ui.salado.value = liveState.salado.toFixed(2);
    if (ui.recreo) ui.recreo.value = liveRec.toFixed(2);
    lastP = liveState.parana;
    lastS = liveState.salado;
    lastR = liveRec;
    updateTextLabels();
    if (changed && !sim.state.running && sim.state.fallenMm === 0) {
      sim.resetWaterOnly();
      sim.state.riverSettle = 18;
    }
    updateSimUI();
    renderer.requestRender();
  }

  return {
    getVisualState,
    renderLiveBox,
    updateTextLabels,
    updateSimUI,
    updateInspector,
    syncPresetUI,
    jumpToPlace,
    handleTerrainClick,
    applyURLParams,
    applyLiveRiversIfIdle,
    setBasemap,
    showToast,
  };
}
