// Punto de entrada modular del visor 3D Santa Fe (compatible con carga HTTP cacheada y bundle offline).
import { createLiveState, refreshLiveData } from "./live-data.js";
import { createSimEngine } from "./sim-engine.js";
import { createWebGLRenderer } from "./webgl-renderer.js";
import { initUI } from "./ui.js";

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("No se pudo cargar imagen: " + src));
    img.src = src;
  });
}

function imgToData(img) {
  const c = document.createElement("canvas");
  c.width = img.width;
  c.height = img.height;
  const ctx = c.getContext("2d");
  ctx.drawImage(img, 0, 0);
  return ctx.getImageData(0, 0, img.width, img.height).data;
}

async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Error cargando ${url} (HTTP ${res.status})`);
  return res.json();
}

async function fetchOptionalJSON(url) {
  if (window.location.protocol === "file:") return null;
  try {
    const res = await fetch(url);
    return res.ok ? await res.json() : null;
  } catch (_) {
    return null;
  }
}

async function bootstrap() {
  const bundle = window.__OFFLINE_BUNDLE__ || null;

  const [
    regionCfg,
    cityPumps,
    osmFacilities,
    osmLines,
    demImg,
    layersImg,
    acumImg,
    cachedLive,
  ] = await Promise.all([
    bundle ? Promise.resolve(bundle.regionCfg) : fetchJSON("./config/region_santa_fe.json"),
    bundle ? Promise.resolve(bundle.cityPumps) : fetchJSON("./assets/city_pumps.json"),
    bundle ? Promise.resolve(bundle.osmFacilities) : fetchJSON("./assets/osm_facilities.json"),
    bundle ? Promise.resolve(bundle.osmLines) : fetchJSON("./assets/osm_lines.json"),
    loadImage(bundle ? bundle.demSrc : "./assets/dem.png"),
    loadImage(bundle ? bundle.layersSrc : "./assets/layers.png"),
    loadImage(bundle ? bundle.acumSrc : "./assets/acum.png"),
    bundle ? Promise.resolve(bundle.liveCache || null) : fetchOptionalJSON("./datos_en_vivo.json"),
  ]);

  const ovPaths = regionCfg.research_overrides || {};
  const [defensasOv, bombeoOv, reservoriosOv] = await Promise.all([
    ovPaths.defensas ? fetchOptionalJSON(ovPaths.defensas) : Promise.resolve(null),
    ovPaths.bombeo_capacidades ? fetchOptionalJSON(ovPaths.bombeo_capacidades) : Promise.resolve(null),
    ovPaths.reservorios ? fetchOptionalJSON(ovPaths.reservorios) : Promise.resolve(null),
  ]);

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

  const demRGBA = imgToData(demImg);
  const layersRGBA = imgToData(layersImg);
  const acumRGBA = imgToData(acumImg);

  const heightsM = new Float32Array(cfg.MW * cfg.MH);
  for (let i = 0; i < cfg.MW * cfg.MH; i++) {
    const u16 = (demRGBA[i * 4] << 8) | demRGBA[i * 4 + 1];
    heightsM[i] = cfg.demMin + (u16 / 65535.0) * (cfg.demMax - cfg.demMin);
  }

  const liveState = createLiveState(regionCfg, cachedLive);
  const sim = createSimEngine({
    cfg,
    heightsM,
    layersRGBA,
    acumRGBA,
    cityPumps,
    osmFacilities,
    osmLines,
    researchOverrides: {
      defensas: defensasOv,
      bombeo_capacidades: bombeoOv,
      reservorios: reservoriosOv,
    },
  });

  let uiController = null;
  const renderer = createWebGLRenderer({
    canvas: document.getElementById("glcanvas"),
    labelsLayer: document.getElementById("labels-layer"),
    cfg,
    heightsM,
    layersImg,
    acumImg,
    cityPumps,
    osmLines,
    osmFacilities,
    places: regionCfg.places,
    sim,
    getVisualState: () =>
      uiController
        ? uiController.getVisualState()
        : {
            zScale: 28,
            hsStrength: 0.7,
            riskAlpha: 0.62,
            riskMask: 15,
            showBin: true,
            showAcum: false,
            threshLog: 3.699,
            showWater: true,
            showParks: true,
            showLandfill: true,
            showRes: true,
            showContours: false,
            showCityPumps: true,
            showOsmLines: true,
            showOsmFac: true,
            showLabels: true,
            sidebarOpen: window.innerWidth > 920,
          },
    onSimTick: () => {
      if (!uiController) return;
      uiController.updateSimUI();
      const pin = renderer.getPin();
      if (pin) uiController.updateInspector(pin.u, pin.v);
    },
    onHoverTerrain: hit => uiController?.updateInspector(hit.u, hit.v),
    onClickTerrain: hit => uiController?.handleTerrainClick(hit),
    onLabelClick: name => uiController?.jumpToPlace(name),
    onPresetChange: preset => uiController?.syncPresetUI(preset),
    onContextStatus: lost =>
      uiController?.showToast(
        lost ? "Contexto WebGL2 suspendido. Recuperando..." : "Contexto WebGL2 restaurado.",
        3500
      ),
  });

  async function doRefreshLive(applyRivers = false) {
    await refreshLiveData(liveState, regionCfg, cachedLive);
    uiController.renderLiveBox();
    if (applyRivers) uiController.applyLiveRiversIfIdle();
  }

  uiController = initUI({
    cfg,
    regionCfg,
    places: regionCfg.places,
    sim,
    liveState,
    onRefreshLive: doRefreshLive,
    renderer,
  });

  const params = new URLSearchParams(window.location.search);
  const { hasCustom, hasStep } = uiController.applyURLParams(params);
  uiController.renderLiveBox();

  document.getElementById("loading").classList.add("hidden");
  renderer.requestRender(true);

  // Refrescar telemetría en vivo sin bloquear el primer render
  doRefreshLive(!hasCustom && !hasStep);

  // Exponer referencia liviana para diagnóstico/testing automatizado
  window.__sf3d = { cfg, sim, liveState, renderer };
}

bootstrap().catch(err => {
  const txt = document.getElementById("loading-text");
  if (txt) txt.textContent = "Error cargando visor 3D: " + err.message;
  console.error(err);
});
