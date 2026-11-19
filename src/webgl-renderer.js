// Motor WebGL2 con renderizado bajo demanda (dirty flag), picking cacheado, labels sin reflow,
// manejo de pérdida de contexto GPU y basemaps online con cancelación anti-race-condition.
import { WATER_THRESHOLDS } from "./sim-engine.js";

function mat4Perspective(fovRad, aspect, near, far) {
  const f = 1.0 / Math.tan(fovRad / 2);
  const nf = 1.0 / (near - far);
  return new Float32Array([
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, (far + near) * nf, -1,
    0, 0, 2 * far * near * nf, 0,
  ]);
}

function mat4LookAt(eye, target, up) {
  let zx = eye[0] - target[0], zy = eye[1] - target[1], zz = eye[2] - target[2];
  let len = Math.hypot(zx, zy, zz) || 1;
  zx /= len; zy /= len; zz /= len;
  let xx = up[1] * zz - up[2] * zy, xy = up[2] * zx - up[0] * zz, xz = up[0] * zy - up[1] * zx;
  len = Math.hypot(xx, xy, xz) || 1;
  xx /= len; xy /= len; xz /= len;
  const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
  return new Float32Array([
    xx, yx, zx, 0,
    xy, yy, zy, 0,
    xz, yz, zz, 0,
    -(xx * eye[0] + xy * eye[1] + xz * eye[2]),
    -(yx * eye[0] + yy * eye[1] + yz * eye[2]),
    -(zx * eye[0] + zy * eye[1] + zz * eye[2]),
    1,
  ]);
}

function mat4Mul(a, b) {
  const out = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      out[c * 4 + r] =
        a[r] * b[c * 4] +
        a[r + 4] * b[c * 4 + 1] +
        a[r + 8] * b[c * 4 + 2] +
        a[r + 12] * b[c * 4 + 3];
    }
  }
  return out;
}

function mat4Invert(m) {
  const inv = new Float32Array(16);
  inv[0] = m[5]*m[10]*m[15]-m[5]*m[11]*m[14]-m[9]*m[6]*m[15]+m[9]*m[7]*m[14]+m[13]*m[6]*m[11]-m[13]*m[7]*m[10];
  inv[4] = -m[4]*m[10]*m[15]+m[4]*m[11]*m[14]+m[8]*m[6]*m[15]-m[8]*m[7]*m[14]-m[12]*m[6]*m[11]+m[12]*m[7]*m[10];
  inv[8] = m[4]*m[9]*m[15]-m[4]*m[11]*m[13]-m[8]*m[5]*m[15]+m[8]*m[7]*m[13]+m[12]*m[5]*m[11]-m[12]*m[7]*m[9];
  inv[12] = -m[4]*m[9]*m[14]+m[4]*m[10]*m[13]+m[8]*m[5]*m[14]-m[8]*m[6]*m[13]-m[12]*m[5]*m[10]+m[12]*m[6]*m[9];
  inv[1] = -m[1]*m[10]*m[15]+m[1]*m[11]*m[14]+m[9]*m[2]*m[15]-m[9]*m[3]*m[14]-m[13]*m[2]*m[11]+m[13]*m[3]*m[10];
  inv[5] = m[0]*m[10]*m[15]-m[0]*m[11]*m[14]-m[8]*m[2]*m[15]+m[8]*m[3]*m[14]+m[12]*m[2]*m[11]-m[12]*m[3]*m[10];
  inv[9] = -m[0]*m[9]*m[15]+m[0]*m[11]*m[13]+m[8]*m[1]*m[15]-m[8]*m[3]*m[13]-m[12]*m[1]*m[11]+m[12]*m[3]*m[9];
  inv[13] = m[0]*m[9]*m[14]-m[0]*m[10]*m[13]-m[8]*m[1]*m[14]+m[8]*m[2]*m[13]+m[12]*m[1]*m[10]-m[12]*m[2]*m[9];
  inv[2] = m[1]*m[6]*m[15]-m[1]*m[7]*m[14]-m[5]*m[2]*m[15]+m[5]*m[3]*m[14]+m[13]*m[2]*m[7]-m[13]*m[3]*m[6];
  inv[6] = -m[0]*m[6]*m[15]+m[0]*m[7]*m[14]+m[4]*m[2]*m[15]-m[4]*m[3]*m[14]-m[12]*m[2]*m[7]+m[12]*m[3]*m[6];
  inv[10] = m[0]*m[5]*m[15]-m[0]*m[7]*m[13]-m[4]*m[1]*m[15]+m[4]*m[3]*m[13]+m[12]*m[1]*m[7]-m[12]*m[3]*m[5];
  inv[14] = -m[0]*m[5]*m[14]+m[0]*m[6]*m[13]+m[4]*m[1]*m[14]-m[4]*m[2]*m[13]-m[12]*m[1]*m[6]+m[12]*m[2]*m[5];
  inv[3] = -m[1]*m[6]*m[11]+m[1]*m[7]*m[10]+m[5]*m[2]*m[11]-m[5]*m[3]*m[10]-m[9]*m[2]*m[7]+m[9]*m[3]*m[6];
  inv[7] = m[0]*m[6]*m[11]-m[0]*m[7]*m[10]-m[4]*m[2]*m[11]+m[4]*m[3]*m[10]+m[8]*m[2]*m[7]-m[8]*m[3]*m[6];
  inv[11] = -m[0]*m[5]*m[11]+m[0]*m[7]*m[9]+m[4]*m[1]*m[11]-m[4]*m[3]*m[9]-m[8]*m[1]*m[7]+m[8]*m[3]*m[5];
  inv[15] = m[0]*m[5]*m[10]-m[0]*m[6]*m[9]-m[4]*m[1]*m[10]+m[4]*m[2]*m[9]+m[8]*m[1]*m[6]-m[8]*m[2]*m[5];
  const det = m[0]*inv[0]+m[1]*inv[4]+m[2]*inv[8]+m[3]*inv[12];
  if (!det) return null;
  for (let i = 0; i < 16; i++) inv[i] /= det;
  return inv;
}

const VS_SRC = `#version 300 es
precision highp float;
layout(location = 0) in vec2 aUV;
layout(location = 1) in float aHeightM;
layout(location = 2) in float aIsSkirt;
uniform mat4 uMVP;
uniform vec2 uWorldSize;
uniform float uZScale;
uniform float uBaseM;
uniform sampler2D uWater;
out vec2 vUV;
out float vHeightM;
out float vSkirt;
void main() {
  vUV = aUV; vHeightM = aHeightM; vSkirt = aIsSkirt;
  vec2 wTex = texture(uWater, aUV).rg;
  float wM = ((wTex.r * 255.0 * 256.0 + wTex.g * 255.0) / 65535.0) * 6.0;
  float x = (aUV.x - 0.5) * uWorldSize.x;
  float z = (aUV.y - 0.5) * uWorldSize.y;
  float y = ((aIsSkirt > 0.5 ? uBaseM : (aHeightM + wM)) - 10.0) * 0.001 * uZScale;
  gl_Position = uMVP * vec4(x, y, z, 1.0);
}`;

// Umbrales de agua unificados: 0.04m (somera), 0.15m (media), 0.40m (profunda)
const FS_SRC = `#version 300 es
precision highp float;
in vec2 vUV;
in float vHeightM;
in float vSkirt;
uniform sampler2D uLayers;
uniform sampler2D uAcum;
uniform sampler2D uWater;
uniform sampler2D uBasemap;
uniform float uBaseMix;
uniform vec2 uTexSize;
uniform float uHSStrength;
uniform float uRiskAlpha;
uniform float uRiskMask;
uniform float uShowBin;
uniform float uShowAcum;
uniform float uThreshLog;
uniform float uShowWater;
uniform float uShowParks;
uniform float uShowLandfill;
uniform float uShowRes;
uniform float uShowContours;
uniform vec2 uPinUV;
uniform float uHasPin;
uniform vec2 uPumps[5];
uniform int uPumpCount;
uniform sampler2D uCityPumpsTex;
uniform float uShowCityPumps;
uniform float uCityPumpsActive;
uniform sampler2D uOsmLinesTex;
uniform float uShowOsmLines;
uniform sampler2D uOsmFacTex;
uniform float uShowOsmFac;
out vec4 outColor;

float sampleAcumLog(vec2 uv) {
  vec3 a = texture(uAcum, clamp(uv, 0.0, 1.0)).rgb;
  return ((a.r * 255.0 * 256.0 + a.g * 255.0) / 65535.0) * 6.5;
}

void main() {
  if (vSkirt > 0.5) { outColor = vec4(0.07, 0.11, 0.18, 1.0); return; }

  vec4 lay = texture(uLayers, vUV);
  int riskId = int(floor(lay.r * 255.0 + 0.5));
  int ctxId  = int(floor(lay.g * 255.0 + 0.5));
  float hs   = texture(uAcum, vUV).b;

  float tElev = clamp((vHeightM - 9.0) / 14.0, 0.0, 1.0);
  vec3 lowAlluvial = vec3(0.81, 0.84, 0.82);
  vec3 midTerrace  = vec3(0.90, 0.90, 0.87);
  vec3 highUrban   = vec3(0.98, 0.96, 0.93);
  vec3 baseCol = (tElev < 0.45)
    ? mix(lowAlluvial, midTerrace, tElev / 0.45)
    : mix(midTerrace, highUrban, (tElev - 0.45) / 0.55);
  float shade = mix(1.0, 0.56 + 0.58 * hs, uHSStrength);
  if (uBaseMix > 0.01) baseCol = mix(baseCol, texture(uBasemap, vUV).rgb, uBaseMix);
  float effShade = mix(shade, mix(1.0, 0.80 + 0.28 * hs, uHSStrength), uBaseMix);
  vec3 col = baseCol * effShade;

  if (uShowContours > 0.5 && vHeightM > 6.0 && vHeightM < 40.0) {
    float stepM = 2.0;
    float f = abs(fract(vHeightM / stepM + 0.5) - 0.5) * stepM;
    float df = max(fwidth(vHeightM), 0.02);
    col = mix(col, vec3(0.45, 0.42, 0.36), (1.0 - smoothstep(0.0, df * 1.1, f)) * 0.32);
  }

  if (uShowWater > 0.5 && (ctxId == 1 || ctxId == 2 || ctxId == 9 || ctxId == 10)) {
    bool isEdge = (ctxId == 2 || ctxId == 10);
    vec3 wCol = isEdge ? vec3(0.12, 0.33, 0.60) : vec3(0.20, 0.46, 0.74);
    float wAlpha = (isEdge ? 0.72 : 0.46) * (1.0 - 0.50 * uBaseMix);
    col = mix(col, wCol * effShade, wAlpha);
  }

  if (uShowParks > 0.5 && (ctxId == 3 || ctxId == 4)) {
    vec3 pCol = (ctxId == 4) ? vec3(0.22, 0.44, 0.25) : vec3(0.38, 0.60, 0.40);
    float pAlpha = ((ctxId == 4) ? 0.78 : 0.42) * (1.0 - 0.50 * uBaseMix);
    col = mix(col, pCol * effShade, pAlpha);
  }

  if (uShowLandfill > 0.5 && (ctxId == 5 || ctxId == 6)) {
    vec3 lCol = (ctxId == 6) ? vec3(0.86, 0.42, 0.05) : vec3(0.86, 0.55, 0.16);
    col = mix(col, lCol, (ctxId == 6) ? 0.90 : 0.45);
  }

  int maskInt = int(floor(uRiskMask + 0.5));
  if (maskInt != 0 && uRiskAlpha > 0.005) {
    vec3 riskCol = vec3(0.0);
    float rA = 0.0;
    if (riskId == 5 && (maskInt & 1) != 0) { riskCol = vec3(0.04, 0.09, 0.85); rA = uRiskAlpha; }
    else if (riskId == 4 && (maskInt & 2) != 0) { riskCol = vec3(0.24, 0.84, 1.00); rA = uRiskAlpha * 0.80; }
    else if (riskId == 3 && (maskInt & 2) != 0 && (maskInt & 4) != 0) { riskCol = vec3(0.20, 0.88, 0.70); rA = uRiskAlpha * 0.78; }
    else if (riskId == 2 && (maskInt & 4) != 0) { riskCol = vec3(0.20, 0.88, 0.54); rA = uRiskAlpha * 0.74; }
    else if (riskId == 1 && (maskInt & 8) != 0) { riskCol = vec3(0.99, 0.98, 0.96); rA = uRiskAlpha * (uBaseMix > 0.1 ? 0.04 : 0.22); }
    col = mix(col, riskCol * mix(0.78, 1.08, hs), rA);
  }

  if (uShowRes > 0.5 && (ctxId == 7 || ctxId == 8)) {
    vec3 resCol = (ctxId == 8) ? vec3(0.05, 0.80, 0.72) : vec3(0.08, 0.65, 0.62);
    col = mix(col, resCol, (ctxId == 8) ? 0.92 : 0.36);
  }

  vec2 duv = fwidth(vUV);
  float texSpan = max(duv.x * uTexSize.x, duv.y * uTexSize.y);
  vec2 stepUV = clamp(duv * 0.42, vec2(0.0), 1.35 / uTexSize);

  if (uShowBin > 0.5) {
    float b = texture(uLayers, vUV).b;
    if (texSpan > 1.1) {
      b = max(b, texture(uLayers, vUV + vec2(stepUV.x, 0.0)).b);
      b = max(b, texture(uLayers, vUV - vec2(stepUV.x, 0.0)).b);
      b = max(b, texture(uLayers, vUV + vec2(0.0, stepUV.y)).b);
      b = max(b, texture(uLayers, vUV - vec2(0.0, stepUV.y)).b);
    }
    if (b > 0.5) col = mix(col, (riskId == 5) ? vec3(0.18, 0.66, 1.0) : vec3(0.03, 0.45, 1.0), 0.92);
  }

  if (uShowAcum > 0.5) {
    float alog = sampleAcumLog(vUV);
    if (texSpan > 1.1) {
      alog = max(alog, sampleAcumLog(vUV + vec2(stepUV.x, 0.0)));
      alog = max(alog, sampleAcumLog(vUV - vec2(stepUV.x, 0.0)));
      alog = max(alog, sampleAcumLog(vUV + vec2(0.0, stepUV.y)));
      alog = max(alog, sampleAcumLog(vUV - vec2(0.0, stepUV.y)));
    }
    if (alog >= uThreshLog) {
      float t = clamp((alog - uThreshLog) / max(5.8 - uThreshLog, 0.4), 0.0, 1.0);
      col = mix(col, mix(vec3(0.12, 0.80, 1.0), vec3(0.02, 0.32, 0.98), t), 0.84);
    }
  }

  if (uShowOsmLines > 0.5) {
    vec4 ol = texture(uOsmLinesTex, vUV);
    if (ol.a > 0.02) col = mix(col, ol.rgb, ol.a * 0.92);
  }

  vec2 wTex = texture(uWater, vUV).rg;
  float wM = ((wTex.r * 255.0 * 256.0 + wTex.g * 255.0) / 65535.0) * 6.0;
  if (wM >= ${WATER_THRESHOLDS.VISIBLE_M.toFixed(2)}) {
    vec3 shallowC = vec3(0.49, 0.83, 0.99); // #7dd3fc (4–15 cm)
    vec3 medC     = vec3(0.01, 0.52, 0.78); // #0284c7 (15–40 cm)
    vec3 deepC    = vec3(0.12, 0.23, 0.54); // #1e3a8a (> 40 cm)
    vec3 wc = (wM < ${WATER_THRESHOLDS.MED_M.toFixed(2)})
      ? mix(shallowC, medC, (wM - ${WATER_THRESHOLDS.VISIBLE_M.toFixed(2)}) / ${(WATER_THRESHOLDS.MED_M - WATER_THRESHOLDS.VISIBLE_M).toFixed(2)})
      : mix(medC, deepC, clamp((wM - ${WATER_THRESHOLDS.MED_M.toFixed(2)}) / ${(WATER_THRESHOLDS.DEEP_M - WATER_THRESHOLDS.MED_M).toFixed(2)}, 0.0, 1.0));
    float rim = (1.0 - smoothstep(0.04, 0.09, wM)) * 0.22;
    float spec = pow(clamp(hs * 1.12, 0.0, 1.0), 4.0) * 0.16;
    vec3 waterLit = wc * mix(0.88, 1.06, hs) + vec3(rim + spec);
    col = mix(col, clamp(waterLit, 0.0, 1.0), mix(0.62, 0.94, clamp((wM - 0.04) / 0.36, 0.0, 1.0)));
  }

  if (uShowOsmFac > 0.5) {
    vec4 of = texture(uOsmFacTex, vUV);
    if (of.a > 0.02) col = mix(col, of.rgb, of.a * 0.95);
  }

  if (uShowCityPumps > 0.5) {
    vec2 cp = texture(uCityPumpsTex, vUV).rg;
    float cov = clamp(cp.r + cp.g, 0.0, 1.0);
    if (cov > 0.02) {
      vec3 fillC = uCityPumpsActive > 0.5 ? vec3(0.02, 0.88, 0.96) : vec3(0.55, 0.62, 0.70);
      vec3 ringC = uCityPumpsActive > 0.5 ? vec3(0.03, 0.22, 0.34) : vec3(0.18, 0.22, 0.28);
      vec3 pCol = mix(ringC, fillC, cp.r / max(0.001, cp.r + cp.g));
      col = mix(col, pCol, cov * 0.95);
    }
  }

  if (uPumpCount > 0) {
    for (int k = 0; k < 5; k++) {
      if (k >= uPumpCount) break;
      float pd = length((vUV - uPumps[k]) * vec2(26.5, 25.7));
      if (pd < 0.50) {
        float halo = smoothstep(0.42, 0.46, pd) * (1.0 - smoothstep(0.46, 0.50, pd));
        float core = 1.0 - smoothstep(0.08, 0.14, pd);
        col = mix(col, vec3(0.05, 0.92, 0.72), max(halo * 0.85, core));
      }
    }
  }

  if (uHasPin > 0.5) {
    float dist = length((vUV - uPinUV) * vec2(26.5, 25.7));
    if (dist < 0.24) {
      float ring = smoothstep(0.12, 0.15, dist) * (1.0 - smoothstep(0.18, 0.22, dist));
      float dotC = 1.0 - smoothstep(0.05, 0.09, dist);
      col = mix(col, vec3(1.0, 0.22, 0.18), max(ring, dotC));
    }
  }

  outColor = vec4(col, 1.0);
}`;

export function createWebGLRenderer({
  canvas,
  labelsLayer,
  cfg,
  heightsM,
  layersImg,
  acumImg,
  cityPumps,
  osmLines,
  osmFacilities,
  places,
  sim,
  getVisualState,
  onSimTick,
  onHoverTerrain,
  onClickTerrain,
  onLabelClick,
  onPresetChange,
  onContextStatus,
}) {
  // Contexto WebGL2 liviano (sin alpha/stencil de canvas completo sobre el compositor)
  const gl = canvas.getContext("webgl2", {
    antialias: true,
    alpha: false,
    depth: true,
    stencil: false,
    powerPreference: "high-performance",
  });
  if (!gl) {
    throw new Error("Este navegador no soporta WebGL2.");
  }

  function lonLatToWorldXZ(lon, lat) {
    const u = (lon - cfg.lonMin) / (cfg.lonMax - cfg.lonMin);
    const v = (cfg.latMax - lat) / (cfg.latMax - cfg.latMin);
    return [(u - 0.5) * cfg.worldW, (v - 0.5) * cfg.worldH, u, v];
  }

  // Pre-rasterizar capas vectoriales en canvases offscreen (reutilizables ante context restore)
  const cpCanvas = document.createElement("canvas");
  cpCanvas.width = cfg.W; cpCanvas.height = cfg.H;
  const cpCtx = cpCanvas.getContext("2d");
  cpCtx.fillStyle = "rgb(0,255,0)";
  for (const cp of cityPumps) {
    cpCtx.beginPath(); cpCtx.arc(cp.u * cfg.W, cp.v * cfg.H, 6.0, 0, Math.PI * 2); cpCtx.fill();
  }
  cpCtx.fillStyle = "rgb(255,0,0)";
  for (const cp of cityPumps) {
    cpCtx.beginPath(); cpCtx.arc(cp.u * cfg.W, cp.v * cfg.H, 4.0, 0, Math.PI * 2); cpCtx.fill();
  }

  const osmLineCanvas = document.createElement("canvas");
  osmLineCanvas.width = cfg.W; osmLineCanvas.height = cfg.H;
  const olCtx = osmLineCanvas.getContext("2d");
  olCtx.lineCap = "round"; olCtx.lineJoin = "round";
  for (const ln of osmLines) {
    if (ln.t !== "c" || ln.p.length < 2) continue;
    olCtx.beginPath();
    olCtx.moveTo(ln.p[0][0] * cfg.W, ln.p[0][1] * cfg.H);
    for (let i = 1; i < ln.p.length; i++) olCtx.lineTo(ln.p[i][0] * cfg.W, ln.p[i][1] * cfg.H);
    olCtx.strokeStyle = "rgba(12, 74, 110, 0.92)"; olCtx.lineWidth = 3.2; olCtx.stroke();
    olCtx.strokeStyle = "rgba(14, 165, 233, 0.98)"; olCtx.lineWidth = 1.7; olCtx.stroke();
  }
  for (const ln of osmLines) {
    if (ln.t !== "d" || ln.p.length < 2) continue;
    olCtx.beginPath();
    olCtx.moveTo(ln.p[0][0] * cfg.W, ln.p[0][1] * cfg.H);
    for (let i = 1; i < ln.p.length; i++) olCtx.lineTo(ln.p[i][0] * cfg.W, ln.p[i][1] * cfg.H);
    olCtx.strokeStyle = "rgba(69, 26, 3, 0.95)"; olCtx.lineWidth = 4.6; olCtx.stroke();
    olCtx.strokeStyle = "rgba(245, 158, 11, 1.0)"; olCtx.lineWidth = 2.6; olCtx.stroke();
  }

  const osmFacCanvas = document.createElement("canvas");
  osmFacCanvas.width = cfg.W; osmFacCanvas.height = cfg.H;
  const ofCtx = osmFacCanvas.getContext("2d");
  const facMask = { s: false, e: false, x: false };
  const drawFacLayer = (code, fill, stroke, rOuter, rInner) => {
    for (const f of osmFacilities) {
      if (f.t !== code) continue;
      const x = f.u * cfg.W, y = f.v * cfg.H;
      ofCtx.beginPath(); ofCtx.arc(x, y, rOuter, 0, Math.PI * 2); ofCtx.fillStyle = stroke; ofCtx.fill();
      ofCtx.beginPath(); ofCtx.arc(x, y, rInner, 0, Math.PI * 2); ofCtx.fillStyle = fill; ofCtx.fill();
    }
  };
  function redrawOsmFacCanvas() {
    ofCtx.clearRect(0, 0, cfg.W, cfg.H);
    if (facMask.e) drawFacLayer("e", "#f59e0b", "#0f172a", 4.1, 2.7);
    if (facMask.x) drawFacLayer("x", "#a855f7", "#0f172a", 4.5, 3.0);
    if (facMask.s) drawFacLayer("s", "#f43f5e", "#ffffff", 5.0, 3.4);
  }
  redrawOsmFacCanvas();

  // Geometría de malla 3D con LOD de 2 niveles compartiendo un único VBO
  const nGrid = cfg.MW * cfg.MH;
  const perimCount = 2 * cfg.MW + 2 * (cfg.MH - 2);
  const verts = new Float32Array((nGrid + perimCount) * 4);
  for (let r = 0; r < cfg.MH; r++) {
    const v = r / (cfg.MH - 1);
    for (let c = 0; c < cfg.MW; c++) {
      const u = c / (cfg.MW - 1);
      const idx = r * cfg.MW + c;
      verts[idx * 4] = u;
      verts[idx * 4 + 1] = v;
      verts[idx * 4 + 2] = heightsM[idx];
      verts[idx * 4 + 3] = 0.0;
    }
  }
  const ring = [];
  for (let c = 0; c < cfg.MW; c++) ring.push(c);
  for (let r = 1; r < cfg.MH; r++) ring.push(r * cfg.MW + (cfg.MW - 1));
  for (let c = cfg.MW - 2; c >= 0; c--) ring.push((cfg.MH - 1) * cfg.MW + c);
  for (let r = cfg.MH - 2; r >= 1; r--) ring.push(r * cfg.MW);
  const gridToSkirtIdx = new Int32Array(nGrid).fill(-1);
  for (let i = 0; i < ring.length; i++) {
    const gi = ring[i], vi = nGrid + i;
    gridToSkirtIdx[gi] = vi;
    verts[vi * 4] = verts[gi * 4];
    verts[vi * 4 + 1] = verts[gi * 4 + 1];
    verts[vi * 4 + 2] = 0.0;
    verts[vi * 4 + 3] = 1.0;
  }
  const indicesFull = new Uint32Array(((cfg.MW - 1) * (cfg.MH - 1) * 2 + ring.length * 2) * 3);
  let ptr = 0;
  for (let r = 0; r < cfg.MH - 1; r++) {
    for (let c = 0; c < cfg.MW - 1; c++) {
      const i0 = r * cfg.MW + c, i1 = i0 + 1, i2 = i0 + cfg.MW, i3 = i2 + 1;
      indicesFull[ptr++] = i0; indicesFull[ptr++] = i2; indicesFull[ptr++] = i1;
      indicesFull[ptr++] = i1; indicesFull[ptr++] = i2; indicesFull[ptr++] = i3;
    }
  }
  for (let i = 0; i < ring.length; i++) {
    const nx = (i + 1) % ring.length;
    const t0 = ring[i], t1 = ring[nx], b0 = nGrid + i, b1 = nGrid + nx;
    indicesFull[ptr++] = t0; indicesFull[ptr++] = b0; indicesFull[ptr++] = t1;
    indicesFull[ptr++] = t1; indicesFull[ptr++] = b0; indicesFull[ptr++] = b1;
  }

  // Índices LOD (stride = 2 -> ~75% menos triángulos durante arrastre o simulación)
  const lodCols = [];
  for (let c = 0; c < cfg.MW; c += 2) lodCols.push(c);
  if (lodCols[lodCols.length - 1] !== cfg.MW - 1) lodCols.push(cfg.MW - 1);
  const lodRows = [];
  for (let r = 0; r < cfg.MH; r += 2) lodRows.push(r);
  if (lodRows[lodRows.length - 1] !== cfg.MH - 1) lodRows.push(cfg.MH - 1);
  const lodRing = [];
  for (let i = 0; i < lodCols.length; i++) lodRing.push(lodCols[i]);
  for (let i = 1; i < lodRows.length; i++) lodRing.push(lodRows[i] * cfg.MW + (cfg.MW - 1));
  for (let i = lodCols.length - 2; i >= 0; i--) lodRing.push((cfg.MH - 1) * cfg.MW + lodCols[i]);
  for (let i = lodRows.length - 2; i >= 1; i--) lodRing.push(lodRows[i] * cfg.MW);
  const indicesLod = new Uint32Array(((lodCols.length - 1) * (lodRows.length - 1) * 2 + lodRing.length * 2) * 3);
  let lPtr = 0;
  for (let ri = 0; ri < lodRows.length - 1; ri++) {
    const r0 = lodRows[ri], r1 = lodRows[ri + 1];
    for (let ci = 0; ci < lodCols.length - 1; ci++) {
      const c0 = lodCols[ci], c1 = lodCols[ci + 1];
      const i0 = r0 * cfg.MW + c0, i1 = r0 * cfg.MW + c1;
      const i2 = r1 * cfg.MW + c0, i3 = r1 * cfg.MW + c1;
      indicesLod[lPtr++] = i0; indicesLod[lPtr++] = i2; indicesLod[lPtr++] = i1;
      indicesLod[lPtr++] = i1; indicesLod[lPtr++] = i2; indicesLod[lPtr++] = i3;
    }
  }
  for (let i = 0; i < lodRing.length; i++) {
    const nx = (i + 1) % lodRing.length;
    const t0 = lodRing[i], t1 = lodRing[nx];
    const b0 = gridToSkirtIdx[t0], b1 = gridToSkirtIdx[t1];
    indicesLod[lPtr++] = t0; indicesLod[lPtr++] = b0; indicesLod[lPtr++] = t1;
    indicesLod[lPtr++] = t1; indicesLod[lPtr++] = b0; indicesLod[lPtr++] = b1;
  }

  let prog = null, vaoFull = null, vaoLod = null, loc = null;
  let waterTex = null, basemapTex = null, osmFacTex = null;
  let contextLost = false;
  let lightMode = false;
  let anisoExt = null, maxAniso = 1, maxTexSize = 4096;
  let baseMixTarget = 0.0;
  let activeBasemapMode = "relief";
  const basemapCache = {};
  let basemapReqId = 0;

  function bindBasemapSource(sourceCanvas) {
    if (contextLost || !basemapTex) return;
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, basemapTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, sourceCanvas);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.generateMipmap(gl.TEXTURE_2D);
    if (anisoExt && maxAniso > 1) {
      gl.texParameterf(gl.TEXTURE_2D, anisoExt.TEXTURE_MAX_ANISOTROPY_EXT, maxAniso);
    }
  }

  function initGPU() {
    maxTexSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) || 4096;
    anisoExt =
      gl.getExtension("EXT_texture_filter_anisotropic") ||
      gl.getExtension("WEBKIT_EXT_texture_filter_anisotropic") ||
      gl.getExtension("MOZ_EXT_texture_filter_anisotropic");
    maxAniso = anisoExt ? Math.min(8, gl.getParameter(anisoExt.MAX_TEXTURE_MAX_ANISOTROPY_EXT) || 1) : 1;

    function compile(type, src) {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    }
    prog = gl.createProgram();
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, VS_SRC));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FS_SRC));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    gl.useProgram(prog);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);

    function makeTex(unit, source, filter) {
      const tex = gl.createTexture();
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
      return tex;
    }

    makeTex(0, layersImg, gl.NEAREST);
    makeTex(1, acumImg, gl.NEAREST);

    waterTex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, waterTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    sim.updateWaterBytes();
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, cfg.SW, cfg.SH, 0, gl.RGBA, gl.UNSIGNED_BYTE, sim.waterTexBytes);

    basemapTex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, basemapTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    if (basemapCache[activeBasemapMode]) {
      bindBasemapSource(basemapCache[activeBasemapMode].canvas);
    } else {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255, 255]));
    }

    makeTex(4, cpCanvas, gl.LINEAR);
    makeTex(5, osmLineCanvas, gl.LINEAR);
    osmFacTex = makeTex(6, osmFacCanvas, gl.LINEAR);

    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);

    const bindAttrib = () => {
      gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
      gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 16, 0);
      gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 1, gl.FLOAT, false, 16, 8);
      gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 1, gl.FLOAT, false, 16, 12);
    };

    vaoFull = gl.createVertexArray();
    gl.bindVertexArray(vaoFull);
    bindAttrib();
    const eboFull = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, eboFull);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indicesFull, gl.STATIC_DRAW);

    vaoLod = gl.createVertexArray();
    gl.bindVertexArray(vaoLod);
    bindAttrib();
    const eboLod = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, eboLod);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indicesLod, gl.STATIC_DRAW);
    gl.bindVertexArray(null);

    const names = [
      "uMVP", "uWorldSize", "uZScale", "uBaseM", "uLayers", "uAcum", "uWater", "uBasemap",
      "uBaseMix", "uTexSize", "uHSStrength", "uRiskAlpha", "uRiskMask", "uShowBin", "uShowAcum",
      "uThreshLog", "uShowWater", "uShowParks", "uShowLandfill", "uShowRes", "uShowContours",
      "uPinUV", "uHasPin", "uPumps", "uPumpCount", "uCityPumpsTex", "uShowCityPumps",
      "uCityPumpsActive", "uOsmLinesTex", "uShowOsmLines", "uOsmFacTex", "uShowOsmFac",
    ];
    loc = Object.fromEntries(names.map(n => [n, gl.getUniformLocation(prog, n)]));
    gl.uniform1i(loc.uLayers, 0);
    gl.uniform1i(loc.uAcum, 1);
    gl.uniform1i(loc.uWater, 2);
    gl.uniform1i(loc.uBasemap, 3);
    gl.uniform1i(loc.uCityPumpsTex, 4);
    gl.uniform1i(loc.uOsmLinesTex, 5);
    gl.uniform1i(loc.uOsmFacTex, 6);
    gl.uniform2f(loc.uWorldSize, cfg.worldW, cfg.worldH);
    gl.uniform2f(loc.uTexSize, cfg.W, cfg.H);
    gl.uniform1f(loc.uBaseM, -5.0);
  }

  initGPU();

  canvas.addEventListener("webglcontextlost", e => {
    e.preventDefault();
    contextLost = true;
    onContextStatus?.(true);
  });
  canvas.addEventListener("webglcontextrestored", () => {
    contextLost = false;
    initGPU();
    resize();
    onContextStatus?.(false);
    requestRender();
  });

  // Etiquetas de barrios posicionadas con translate3d (sin reflow)
  const labelNodes = places.filter(p => p.label).map(lm => {
    const [wx, wz, u, v] = lonLatToWorldXZ(lm.lon, lm.lat);
    const el = document.createElement("button");
    el.type = "button";
    el.className = "map-label" + (lm.res ? " res-lbl" : "");
    el.textContent = lm.name;
    el.title = "Ir a " + lm.name;
    el.addEventListener("click", e => {
      e.stopPropagation();
      onLabelClick?.(lm.name);
    });
    labelsLayer.appendChild(el);
    return { el, wx, wz, hM: sim.sampleHeightAtUV(u, v), isRes: !!lm.res, visible: false };
  });

  // Cámara y presets
  const cam = { tx: 0, ty: 0.2, tz: 0, yaw: -1.32, pitch: 0.48, dist: 14.2 };
  let animCam = null;
  let currentPreset = "cap1";
  let currentMVP = null;
  let cachedInvMVP = null;
  let invMVPDirty = true;
  let labelsDirty = true;
  let pin = null;
  const pumpFlat = new Float32Array(10);

  function getCamEye() {
    const cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch);
    const sy = Math.sin(cam.yaw), cy = Math.cos(cam.yaw);
    return [cam.tx + cam.dist * cp * sy, cam.ty + cam.dist * sp, cam.tz + cam.dist * cp * cy];
  }

  function flyTo(lon, lat, yaw, pitch, dist, immediate = false) {
    const [wx, wz] = lonLatToWorldXZ(lon, lat);
    const end = { tx: wx, ty: 0.2, tz: wz, yaw, pitch, dist };
    if (immediate) {
      Object.assign(cam, end);
      animCam = null;
    } else {
      animCam = { start: { ...cam }, end, t0: performance.now(), dur: 520 };
    }
    labelsDirty = true;
    requestRender();
  }

  function setPreset(name, immediate = false) {
    const valid = ["cap1", "cap2", "res", "costa", "top"];
    const p = valid.includes(name) ? name : "cap1";
    currentPreset = p;
    onPresetChange?.(p);
    if (p === "cap1") flyTo(-60.708, -31.606, -1.32, 0.48, 14.2, immediate);
    else if (p === "cap2") flyTo(-60.698, -31.602, 0.14, 0.54, 20.0, immediate);
    else if (p === "res") flyTo(-60.742, -31.595, -1.15, 0.55, 7.4, immediate);
    else if (p === "costa") flyTo(-60.655, -31.622, 0.65, 0.50, 12.5, immediate);
    else flyTo(-60.695, -31.602, 0.0, 1.50, 24.5, immediate);
  }

  function uploadWaterTexture() {
    if (contextLost || !waterTex) return;
    sim.updateWaterBytes();
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, waterTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, cfg.SW, cfg.SH, gl.RGBA, gl.UNSIGNED_BYTE, sim.waterTexBytes);
  }

  async function downloadTileMosaic({ tx0, tx1, ty0, ty1, urlFn, label, onProgress, isCancelled }) {
    const mercC = document.createElement("canvas");
    mercC.width = (tx1 - tx0 + 1) * 256;
    mercC.height = (ty1 - ty0 + 1) * 256;
    const mctx = mercC.getContext("2d");
    const coords = [];
    for (let ty = ty0; ty <= ty1; ty++) {
      for (let tx = tx0; tx <= tx1; tx++) coords.push({ tx, ty });
    }
    const total = coords.length;
    let ok = 0, done = 0;
    const CONCURRENCY = 16;

    for (let i = 0; i < total; i += CONCURRENCY) {
      if (isCancelled()) return { ok: 0, total, mercC: null, cancelled: true };
      const batch = coords.slice(i, i + CONCURRENCY);
      await Promise.all(
        batch.map(
          ({ tx, ty }) =>
            new Promise(res => {
              const im = new Image();
              im.crossOrigin = "anonymous";
              im.onload = () => {
                if (!isCancelled()) mctx.drawImage(im, (tx - tx0) * 256, (ty - ty0) * 256);
                ok++;
                done++;
                res();
              };
              im.onerror = () => {
                done++;
                res();
              };
              im.src = urlFn(tx, ty);
            })
        )
      );
      if (isCancelled()) return { ok: 0, total, mercC: null, cancelled: true };
      onProgress?.(`${label} (${done}/${total})...`);
    }
    return { ok, total, mercC, cancelled: false };
  }

  async function loadOnlineBasemap(mode, onStatus) {
    const myReq = ++basemapReqId;
    activeBasemapMode = mode;
    if (mode === "relief") {
      baseMixTarget = 0.0;
      onStatus?.({ status: "Relieve topográfico offline.", attribution: "", mode: "relief", ok: true });
      requestRender();
      return;
    }

    const cached = basemapCache[mode];
    if (cached) {
      bindBasemapSource(cached.canvas);
      baseMixTarget = mode === "sat" ? 0.98 : 0.95;
      onStatus?.({
        status: mode === "sat" ? "Imagen satelital HD activa." : "Mapa de calles activo.",
        attribution: cached.attr,
        mode,
        ok: true,
      });
      requestRender();
      return;
    }

    const z = 14, n = 16384;
    const lon2tx = lon => ((lon + 180) / 360) * n;
    const lat2ty = lat => ((1 - Math.asinh(Math.tan((lat * Math.PI) / 180)) / Math.PI) / 2) * n;
    const tx0 = Math.floor(lon2tx(cfg.lonMin)), tx1 = Math.floor(lon2tx(cfg.lonMax));
    const ty0 = Math.floor(lat2ty(cfg.latMax)), ty1 = Math.floor(lat2ty(cfg.latMin));
    const isCancelled = () => myReq !== basemapReqId;
    const label = mode === "sat" ? "Descargando satélite HD" : "Descargando calles HD";
    onStatus?.({ status: `${label}...`, attribution: "", mode, ok: true });

    let usedAttr = mode === "sat" ? "Imagen: © Esri World Imagery (HD)" : "Mapa: © Esri · © OpenStreetMap";
    let res = await downloadTileMosaic({
      tx0, tx1, ty0, ty1,
      urlFn: (tx, ty) =>
        mode === "sat"
          ? `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${ty}/${tx}`
          : `https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/${z}/${ty}/${tx}`,
      label,
      onProgress: msg => onStatus?.({ status: msg, attribution: "", mode, ok: true }),
      isCancelled,
    });
    if (res.cancelled) return;

    if (mode === "streets" && res.ok < res.total * 0.5) {
      usedAttr = "Mapa: © OpenStreetMap";
      onStatus?.({ status: "Usando respaldo OpenStreetMap...", attribution: "", mode, ok: true });
      res = await downloadTileMosaic({
        tx0, tx1, ty0, ty1,
        urlFn: (tx, ty) => `https://tile.openstreetmap.org/${z}/${tx}/${ty}.png`,
        label: "Descargando OSM",
        onProgress: msg => onStatus?.({ status: msg, attribution: "", mode, ok: true }),
        isCancelled,
      });
      if (res.cancelled) return;
    }

    if (res.ok < res.total * 0.5) {
      baseMixTarget = 0.0;
      activeBasemapMode = "relief";
      onStatus?.({ status: "Sin conexión: se mantiene relieve offline.", attribution: "", mode: "relief", ok: false });
      requestRender();
      return;
    }

    const targetW = Math.min(maxTexSize, mode === "sat" ? 2560 : 2048);
    const targetH = Math.min(maxTexSize, Math.round(targetW * (cfg.worldH / cfg.worldW)));
    const wgsC = document.createElement("canvas");
    wgsC.width = targetW; wgsC.height = targetH;
    const wctx = wgsC.getContext("2d");
    wctx.imageSmoothingEnabled = true;
    wctx.imageSmoothingQuality = "high";
    const sx0 = (lon2tx(cfg.lonMin) - tx0) * 256;
    const sw = (lon2tx(cfg.lonMax) - lon2tx(cfg.lonMin)) * 256;
    const strips = 16;
    for (let s = 0; s < strips; s++) {
      const dr0 = Math.floor((s * targetH) / strips);
      const dr1 = Math.floor(((s + 1) * targetH) / strips);
      const latTop = cfg.latMax - (dr0 / targetH) * (cfg.latMax - cfg.latMin);
      const latBot = cfg.latMax - (dr1 / targetH) * (cfg.latMax - cfg.latMin);
      const sy0 = (lat2ty(latTop) - ty0) * 256;
      const sy1 = (lat2ty(latBot) - ty0) * 256;
      wctx.drawImage(res.mercC, sx0, sy0, sw, Math.max(0.5, sy1 - sy0), 0, dr0, targetW, dr1 - dr0);
    }

    basemapCache[mode] = { canvas: wgsC, attr: usedAttr };
    bindBasemapSource(wgsC);
    baseMixTarget = mode === "sat" ? 0.98 : 0.95;
    onStatus?.({
      status: mode === "sat" ? "Imagen satelital HD activa." : "Mapa de calles activo.",
      attribution: usedAttr,
      mode,
      ok: true,
    });
    requestRender();
  }

  function pickTerrain(clientX, clientY) {
    if (!currentMVP) return null;
    if (invMVPDirty) {
      cachedInvMVP = mat4Invert(currentMVP);
      invMVPDirty = false;
    }
    const inv = cachedInvMVP;
    if (!inv) return null;
    const rect = canvas.getBoundingClientRect();
    const nx = ((clientX - rect.left) / rect.width) * 2 - 1;
    const ny = 1 - ((clientY - rect.top) / rect.height) * 2;
    const unproj = nz => {
      const x = inv[0] * nx + inv[4] * ny + inv[8] * nz + inv[12];
      const y = inv[1] * nx + inv[5] * ny + inv[9] * nz + inv[13];
      const z = inv[2] * nx + inv[6] * ny + inv[10] * nz + inv[14];
      const w = inv[3] * nx + inv[7] * ny + inv[11] * nz + inv[15];
      return [x / w, y / w, z / w];
    };
    const p0 = unproj(-1), p1 = unproj(1);
    const dx = p1[0] - p0[0], dy = p1[1] - p0[1], dz = p1[2] - p0[2];
    const len = Math.hypot(dx, dy, dz) || 1;
    const rx = dx / len, ry = dy / len, rz = dz / len;
    const zScale = getVisualState().zScale;
    const halfW = cfg.worldW * 0.5, halfH = cfg.worldH * 0.5;
    const surfY = (u, v) => (sim.sampleHeightAtUV(u, v) + sim.sampleWaterAtUV(u, v) - 10.0) * 0.001 * zScale;

    for (let step = 0; step < 80; step++) {
      const t = 0.05 + 89.95 * (step / 80);
      const px = p0[0] + rx * t, py = p0[1] + ry * t, pz = p0[2] + rz * t;
      const u = px / cfg.worldW + 0.5, v = pz / cfg.worldH + 0.5;
      if (u >= 0 && u <= 1 && v >= 0 && v <= 1) {
        if (py <= surfY(u, v)) {
          let lo = 0.05 + 89.95 * (Math.max(0, step - 1) / 80), hi = t;
          for (let k = 0; k < 8; k++) {
            const mid = 0.5 * (lo + hi);
            const mu = (p0[0] + rx * mid) / cfg.worldW + 0.5;
            const mv = (p0[2] + rz * mid) / cfg.worldH + 0.5;
            if (p0[1] + ry * mid <= surfY(mu, mv)) hi = mid;
            else lo = mid;
          }
          const ft = 0.5 * (lo + hi);
          const fu = (p0[0] + rx * ft) / cfg.worldW + 0.5;
          const fv = (p0[2] + rz * ft) / cfg.worldH + 0.5;
          if (fu < 0 || fu > 1 || fv < 0 || fv > 1) return null;
          return { u: fu, v: fv };
        }
      }
      if (Math.abs(px) > halfW + 15 && rx * px > 0) break;
      if (Math.abs(pz) > halfH + 15 && rz * pz > 0) break;
    }
    return null;
  }

  function updateLabels(vis) {
    labelsLayer.style.display = vis.showLabels ? "block" : "none";
    if (!vis.showLabels || !currentMVP) return;
    const vw = window.innerWidth, vh = window.innerHeight;
    const minX = vw > 920 && vis.sidebarOpen ? 372 : 56;
    const minY = 64;
    const maxY = vh - 72;

    for (const lm of labelNodes) {
      if (lm.isRes && !vis.showRes) {
        if (lm.visible) { lm.el.style.display = "none"; lm.visible = false; }
        continue;
      }
      const wy = (lm.hM - 10.0) * 0.001 * vis.zScale + 0.02;
      const cx = currentMVP[0] * lm.wx + currentMVP[4] * wy + currentMVP[8] * lm.wz + currentMVP[12];
      const cy = currentMVP[1] * lm.wx + currentMVP[5] * wy + currentMVP[9] * lm.wz + currentMVP[13];
      const cw = currentMVP[3] * lm.wx + currentMVP[7] * wy + currentMVP[11] * lm.wz + currentMVP[15];
      if (cw > 0.1) {
        const sx = (cx / cw * 0.5 + 0.5) * vw;
        const sy = (-cy / cw * 0.5 + 0.5) * vh;
        if (sx > minX && sx < vw - 34 && sy > minY && sy < maxY) {
          if (!lm.visible) { lm.el.style.display = "block"; lm.visible = true; }
          lm.el.style.transform = `translate3d(${sx.toFixed(1)}px, ${sy.toFixed(1)}px, 0) translate(-50%, -100%)`;
        } else if (lm.visible) {
          lm.el.style.display = "none";
          lm.visible = false;
        }
      } else if (lm.visible) {
        lm.el.style.display = "none";
        lm.visible = false;
      }
    }
    labelsDirty = false;
  }

  const stats = { framesRendered: 0, isIdle: true, lastFrameMs: 0 };
  if (typeof window !== "undefined") window.__sf3dStats = stats;

  let dirty = true;
  let rafId = null;
  let lastTickMs = 0;
  let simFrameCounter = 0;
  let lastRenderedLod = false;
  let hiResTimer = null;
  let wheelUntil = 0;
  let dragMode = null, lastX = 0, lastY = 0, downX = 0, downY = 0;
  let hoverQueued = false, hoverX = 0, hoverY = 0, lastHoverMs = 0;
  let touchState = null;

  function scheduleHiRes() {
    if (lightMode) return;
    clearTimeout(hiResTimer);
    hiResTimer = setTimeout(() => {
      hiResTimer = null;
      requestRender();
    }, 140);
  }

  function renderNow(useLod = false) {
    if (contextLost) return;
    const vis = getVisualState();

    gl.clearColor(0.03, 0.05, 0.09, 1.0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);

    const aspect = canvas.width / Math.max(1, canvas.height);
    const proj = mat4Perspective((42 * Math.PI) / 180, aspect, 0.1, 160.0);
    const view = mat4LookAt(getCamEye(), [cam.tx, cam.ty, cam.tz], [0, 1, 0]);
    currentMVP = mat4Mul(proj, view);
    invMVPDirty = true;

    const pumps = sim.manualPumps;
    for (let i = 0; i < Math.min(5, pumps.length); i++) {
      pumpFlat[i * 2] = pumps[i].u;
      pumpFlat[i * 2 + 1] = pumps[i].v;
    }

    gl.useProgram(prog);
    gl.uniformMatrix4fv(loc.uMVP, false, currentMVP);
    gl.uniform1f(loc.uZScale, vis.zScale);
    gl.uniform1f(loc.uBaseMix, baseMixTarget);
    gl.uniform1f(loc.uHSStrength, vis.hsStrength);
    gl.uniform1f(loc.uRiskAlpha, vis.riskAlpha);
    gl.uniform1f(loc.uRiskMask, vis.riskMask);
    gl.uniform1f(loc.uShowBin, vis.showBin ? 1.0 : 0.0);
    gl.uniform1f(loc.uShowAcum, vis.showAcum ? 1.0 : 0.0);
    gl.uniform1f(loc.uThreshLog, vis.threshLog);
    gl.uniform1f(loc.uShowWater, vis.showWater ? 1.0 : 0.0);
    gl.uniform1f(loc.uShowParks, vis.showParks ? 1.0 : 0.0);
    gl.uniform1f(loc.uShowLandfill, vis.showLandfill ? 1.0 : 0.0);
    gl.uniform1f(loc.uShowRes, vis.showRes ? 1.0 : 0.0);
    gl.uniform1f(loc.uShowContours, vis.showContours ? 1.0 : 0.0);
    gl.uniform1f(loc.uHasPin, pin ? 1.0 : 0.0);
    if (pin) gl.uniform2f(loc.uPinUV, pin.u, pin.v);
    gl.uniform2fv(loc.uPumps, pumpFlat);
    gl.uniform1i(loc.uPumpCount, Math.min(5, pumps.length));
    gl.uniform1f(loc.uShowCityPumps, vis.showCityPumps ? 1.0 : 0.0);
    gl.uniform1f(loc.uCityPumpsActive, sim.state.cityPumpsActive ? 1.0 : 0.0);
    gl.uniform1f(loc.uShowOsmLines, vis.showOsmLines ? 1.0 : 0.0);
    gl.uniform1f(loc.uShowOsmFac, vis.showOsmFac ? 1.0 : 0.0);

    const drawLod = useLod || lightMode;
    gl.bindVertexArray(drawLod ? vaoLod : vaoFull);
    gl.drawElements(gl.TRIANGLES, drawLod ? indicesLod.length : indicesFull.length, gl.UNSIGNED_INT, 0);
    lastRenderedLod = drawLod;

    if (labelsDirty) updateLabels(vis);
    stats.framesRendered++;
    stats.lastFrameMs = performance.now();
    canvas.dataset.frames = String(stats.framesRendered);
    dirty = false;
  }

  function tick(now) {
    rafId = null;
    const dtSec = lastTickMs > 0 ? (now - lastTickMs) / 1000 : 1 / 60;
    lastTickMs = now;

    if (animCam) {
      const t = Math.min(1, (now - animCam.t0) / animCam.dur);
      const ease = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      for (const k of ["tx", "ty", "tz", "yaw", "pitch", "dist"]) {
        cam[k] = animCam.start[k] + (animCam.end[k] - animCam.start[k]) * ease;
      }
      labelsDirty = true;
      dirty = true;
      if (t >= 1) animCam = null;
    }

    const simActive = sim.state.running || sim.state.riverSettle > 0 || sim.state.pumpSettle > 0;
    if (simActive) {
      const wantMetrics = simFrameCounter % 4 === 0;
      const stepped = sim.advanceWall(dtSec, { updateMetricsNow: wantMetrics });
      if (stepped) {
        uploadWaterTexture();
        dirty = true;
        simFrameCounter++;
        const doneNow = !sim.state.running && sim.state.riverSettle === 0 && sim.state.pumpSettle === 0;
        if (doneNow && !wantMetrics) sim.updateMetrics();
        if (wantMetrics || doneNow) onSimTick?.(doneNow);
      }
    }

    const interacting =
      dragMode !== null ||
      touchState !== null ||
      animCam !== null ||
      simActive ||
      lightMode ||
      now < wheelUntil;

    if (dirty || labelsDirty) {
      renderNow(interacting);
    }

    const stillActive =
      animCam !== null ||
      sim.state.running ||
      sim.state.riverSettle > 0 ||
      sim.state.pumpSettle > 0 ||
      dirty;

    if (stillActive) {
      stats.isIdle = false;
      canvas.dataset.idle = "false";
      rafId = requestAnimationFrame(tick);
    } else {
      stats.isIdle = true;
      canvas.dataset.idle = "true";
      lastTickMs = 0;
      if (lastRenderedLod && !lightMode && !interacting) {
        scheduleHiRes();
      }
    }
  }

  function requestRender(markLabels = false) {
    clearTimeout(hiResTimer);
    hiResTimer = null;
    dirty = true;
    if (markLabels) labelsDirty = true;
    if (rafId === null) {
      stats.isIdle = false;
      rafId = requestAnimationFrame(tick);
    }
  }

  function resize() {
    const maxDpr = lightMode ? 1.0 : 1.5;
    const dpr = Math.min(window.devicePixelRatio || 1, maxDpr);
    canvas.width = Math.max(1, Math.floor(window.innerWidth * dpr));
    canvas.height = Math.max(1, Math.floor(window.innerHeight * dpr));
    if (!contextLost) gl.viewport(0, 0, canvas.width, canvas.height);
    labelsDirty = true;
    requestRender(true);
  }
  window.addEventListener("resize", resize);
  resize();

  function setLightMode(enabled) {
    lightMode = !!enabled;
    resize();
  }

  function updateOsmFacilitiesMask(showSalud, showEscuelas, showEmerg) {
    facMask.s = !!showSalud;
    facMask.e = !!showEscuelas;
    facMask.x = !!showEmerg;
    redrawOsmFacCanvas();
    if (!contextLost && osmFacTex) {
      gl.activeTexture(gl.TEXTURE6);
      gl.bindTexture(gl.TEXTURE_2D, osmFacTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, osmFacCanvas);
    }
    requestRender();
  }

  // Controles de ratón (con hover throttled a ~16/s), tacto y teclado
  canvas.addEventListener("contextmenu", e => e.preventDefault());
  canvas.addEventListener("mousedown", e => {
    animCam = null;
    lastX = downX = e.clientX;
    lastY = downY = e.clientY;
    dragMode = e.button === 2 || e.shiftKey ? "pan" : "orbit";
    canvas.classList.add("dragging");
  });

  window.addEventListener("mouseup", e => {
    if (dragMode) {
      const moved = Math.hypot(e.clientX - downX, e.clientY - downY);
      if (moved < 4 && e.button === 0 && e.target === canvas) {
        const hit = pickTerrain(e.clientX, e.clientY);
        onClickTerrain?.(hit);
      }
    }
    dragMode = null;
    canvas.classList.remove("dragging");
    if (lastRenderedLod && !lightMode) scheduleHiRes();
  });

  window.addEventListener("mousemove", e => {
    if (dragMode === "orbit") {
      cam.yaw -= (e.clientX - lastX) * 0.0065;
      cam.pitch = Math.max(0.08, Math.min(1.54, cam.pitch + (e.clientY - lastY) * 0.0065));
      lastX = e.clientX; lastY = e.clientY;
      requestRender(true);
    } else if (dragMode === "pan") {
      const dx = e.clientX - lastX, dy = e.clientY - lastY;
      const scale = cam.dist * 0.0014;
      const sy = Math.sin(cam.yaw), cy = Math.cos(cam.yaw);
      cam.tx -= (cy * dx + sy * dy) * scale;
      cam.tz -= (-sy * dx + cy * dy) * scale;
      lastX = e.clientX; lastY = e.clientY;
      requestRender(true);
    } else if (!pin && e.target === canvas) {
      hoverX = e.clientX; hoverY = e.clientY;
      const now = performance.now();
      if (!hoverQueued && now - lastHoverMs >= 60) {
        hoverQueued = true;
        requestAnimationFrame(() => {
          hoverQueued = false;
          lastHoverMs = performance.now();
          if (!dragMode && !pin) {
            const hit = pickTerrain(hoverX, hoverY);
            if (hit) onHoverTerrain?.(hit);
          }
        });
      }
    }
  });

  canvas.addEventListener("wheel", e => {
    e.preventDefault();
    animCam = null;
    wheelUntil = performance.now() + 120;
    cam.dist = Math.max(1.4, Math.min(48.0, cam.dist * Math.exp(e.deltaY * 0.0011)));
    requestRender(true);
    if (!lightMode) scheduleHiRes();
  }, { passive: false });

  canvas.addEventListener("touchstart", e => {
    animCam = null;
    if (e.touches.length === 1) {
      touchState = {
        mode: "orbit",
        x: e.touches[0].clientX,
        y: e.touches[0].clientY,
        startX: e.touches[0].clientX,
        startY: e.touches[0].clientY,
        moved: false,
      };
    } else if (e.touches.length === 2) {
      const d = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
      touchState = {
        mode: "pinch",
        dist: d,
        cx: 0.5 * (e.touches[0].clientX + e.touches[1].clientX),
        cy: 0.5 * (e.touches[0].clientY + e.touches[1].clientY),
        moved: true,
      };
    }
  }, { passive: true });

  canvas.addEventListener("touchmove", e => {
    if (!touchState) return;
    e.preventDefault();
    if (touchState.mode === "orbit" && e.touches.length === 1) {
      const dx = e.touches[0].clientX - touchState.x;
      const dy = e.touches[0].clientY - touchState.y;
      if (Math.hypot(e.touches[0].clientX - touchState.startX, e.touches[0].clientY - touchState.startY) > 6) {
        touchState.moved = true;
      }
      cam.yaw -= dx * 0.007;
      cam.pitch = Math.max(0.08, Math.min(1.54, cam.pitch + dy * 0.007));
      touchState.x = e.touches[0].clientX;
      touchState.y = e.touches[0].clientY;
      requestRender(true);
    } else if (touchState.mode === "pinch" && e.touches.length === 2) {
      const d = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
      const cx = 0.5 * (e.touches[0].clientX + e.touches[1].clientX);
      const cy = 0.5 * (e.touches[0].clientY + e.touches[1].clientY);
      cam.dist = Math.max(1.4, Math.min(48.0, cam.dist * (touchState.dist / Math.max(d, 10))));
      const scale = cam.dist * 0.0014, sy = Math.sin(cam.yaw), cyw = Math.cos(cam.yaw);
      cam.tx -= (cyw * (cx - touchState.cx) + sy * (cy - touchState.cy)) * scale;
      cam.tz -= (-sy * (cx - touchState.cx) + cyw * (cy - touchState.cy)) * scale;
      touchState.dist = d; touchState.cx = cx; touchState.cy = cy;
      requestRender(true);
    }
  }, { passive: false });

  canvas.addEventListener("touchend", () => {
    if (touchState && touchState.mode === "orbit" && !touchState.moved) {
      const hit = pickTerrain(touchState.startX, touchState.startY);
      onClickTerrain?.(hit);
    }
    touchState = null;
    if (lastRenderedLod && !lightMode) scheduleHiRes();
  });

  // Navegación por teclado cuando el canvas tiene foco
  canvas.addEventListener("keydown", e => {
    if (e.key === "ArrowLeft") { cam.yaw -= 0.08; requestRender(true); e.preventDefault(); }
    else if (e.key === "ArrowRight") { cam.yaw += 0.08; requestRender(true); e.preventDefault(); }
    else if (e.key === "ArrowUp") { cam.pitch = Math.min(1.54, cam.pitch + 0.06); requestRender(true); e.preventDefault(); }
    else if (e.key === "ArrowDown") { cam.pitch = Math.max(0.08, cam.pitch - 0.06); requestRender(true); e.preventDefault(); }
    else if (e.key === "+" || e.key === "=") { cam.dist = Math.max(1.4, cam.dist * 0.88); requestRender(true); e.preventDefault(); }
    else if (e.key === "-") { cam.dist = Math.min(48.0, cam.dist * 1.12); requestRender(true); e.preventDefault(); }
  });

  return {
    cam,
    stats,
    lonLatToWorldXZ,
    flyTo,
    setPreset,
    getCurrentPreset: () => currentPreset,
    setPin: nextPin => { pin = nextPin; requestRender(); },
    getPin: () => pin,
    uploadWaterTexture,
    loadOnlineBasemap,
    setLightMode,
    updateOsmFacilitiesMask,
    requestRender,
    renderNow,
    capturePNG: () => {
      renderNow(false);
      return canvas.toDataURL("image/png");
    },
  };
}
