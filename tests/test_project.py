#!/usr/bin/env python3
"""
Suite de pruebas unitarias e integridad del proyecto Santa Fe 3D.
Compatible con `python -m unittest` y `pytest` (solo biblioteca estandar).
"""

import copy
import json
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

import actualizar_datos_vivo as adv  # noqa: E402
import build_offline as boff  # noqa: E402
import descargar_osm as dosm  # noqa: E402
import sync_assets_json as saj  # noqa: E402


class TestConfigAndAssets(unittest.TestCase):
    def test_region_config_schema(self):
        cfg = json.loads((ROOT / "config" / "region_santa_fe.json").read_text(encoding="utf-8"))
        for key in ("bbox", "grid", "entre_rios_filter", "hydrometry", "weather", "places", "research_overrides"):
            self.assertIn(key, cfg)
        self.assertIn("puntos_criticos_empiricos", cfg["research_overrides"])
        self.assertEqual(len(cfg["hydrometry"]["stations"]), 3)
        self.assertGreaterEqual(len(cfg["places"]), 19)
        self.assertGreaterEqual(sum(1 for p in cfg["places"] if p.get("barrio_ref")), 19)
        places_by_name = {p["name"]: p for p in cfg["places"]}
        self.assertIn("Alto Verde", places_by_name)
        av = places_by_name["Alto Verde"]
        self.assertGreaterEqual(av["lon"], -60.705)
        self.assertLessEqual(av["lon"], -60.690)
        self.assertGreaterEqual(av["lat"], -31.675)
        self.assertLessEqual(av["lat"], -31.652)
        self.assertIn("La Boca (Alto Verde)", places_by_name)

    def test_geojson_and_assets_sync(self):
        ln_gj = json.loads((ROOT / "datos/vectores/osm_canales_defensas.geojson").read_text(encoding="utf-8"))
        pm_gj = json.loads((ROOT / "datos/vectores/estaciones_bombeo_aprox.geojson").read_text(encoding="utf-8"))
        rs_gj = json.loads((ROOT / "datos/vectores/reservorios_santa_fe.geojson").read_text(encoding="utf-8"))

        ln_as = json.loads((ROOT / "assets/osm_lines.json").read_text(encoding="utf-8"))
        pm_as = json.loads((ROOT / "assets/city_pumps.json").read_text(encoding="utf-8"))

        self.assertFalse((ROOT / "assets/osm_facilities.json").exists())
        self.assertFalse((ROOT / "datos/vectores/osm_equipamiento_critico.geojson").exists())
        self.assertEqual(len(ln_gj["features"]), len(ln_as))
        self.assertEqual(len(pm_gj["features"]), len(pm_as))
        self.assertGreater(len(rs_gj["features"]), 0)

        for f in ln_gj["features"]:
            self.assertIn("longitud_m", f["properties"])
            self.assertIn("cota_media_fabdem_m", f["properties"])
        for f in pm_gj["features"]:
            self.assertIn("cota_fabdem_m", f["properties"])

    def test_osm_lines_strictly_inside_unit_bbox(self):
        ln_as = json.loads((ROOT / "assets/osm_lines.json").read_text(encoding="utf-8"))
        for item in ln_as:
            self.assertGreaterEqual(len(item["p"]), 2)
            for u, v in item["p"]:
                self.assertGreaterEqual(u, 0.0, f"u fuera de rango: {u}")
                self.assertLessEqual(u, 1.0, f"u fuera de rango: {u}")
                self.assertGreaterEqual(v, 0.0, f"v fuera de rango: {v}")
                self.assertLessEqual(v, 1.0, f"v fuera de rango: {v}")

    def test_phase6_overrides_valid(self):
        cfg = json.loads((ROOT / "config" / "region_santa_fe.json").read_text(encoding="utf-8"))
        parana_st = next(s for s in cfg["hydrometry"]["stations"] if s["key"] == "parana_santa_fe")
        self.assertAlmostEqual(parana_st["cero_ign_m"], 8.20, places=2)
        ov = cfg.get("research_overrides") or {}
        for key in ("defensas", "puntos_criticos_empiricos", "eventos_calibracion"):
            rel = ov.get(key)
            self.assertTrue(rel, f"Override {key} debe estar configurado")
            p = ROOT / rel
            self.assertTrue(p.exists(), f"Falta archivo override {p}")
            doc = json.loads(p.read_text(encoding="utf-8"))
            self.assertIsInstance(doc, dict)
        def_doc = json.loads((ROOT / ov["defensas"]).read_text(encoding="utf-8"))
        tramo_names = [t.get("nombre", "") for t in def_doc.get("tramos", [])]
        self.assertGreaterEqual(len(tramo_names), 3)
        self.assertFalse(any("El Pozo" in n or "Alto Verde" in n for n in tramo_names))
        self.assertGreaterEqual(len(def_doc.get("anillos_protegidos", [])), 5)

    def test_city_pumps_not_on_open_water(self):
        from validar_eventos import decode_png_rgba

        cfg = json.loads((ROOT / "config" / "region_santa_fe.json").read_text(encoding="utf-8"))
        w, h = cfg["grid"]["w"], cfg["grid"]["h"]
        lay = decode_png_rgba(ROOT / "assets" / "layers.png")
        pumps = json.loads((ROOT / "assets" / "city_pumps.json").read_text(encoding="utf-8"))
        self.assertEqual(len(pumps), 59)
        for p in pumps:
            px, py = round(p["u"] * (w - 1)), round(p["v"] * (h - 1))
            cid = lay[(py * w + px) * 4 + 1]
            self.assertNotIn(cid, (1, 2, 9, 10), f"Estacion de bombeo #{p['id']} cae sobre espejo de agua (ctxId={cid})")

    def test_png_assets_exist_and_valid_header(self):
        for name in ("dem.png", "layers.png", "acum.png"):
            p = ROOT / "assets" / name
            self.assertTrue(p.exists(), f"Falta {p}")
            data = p.read_bytes()
            self.assertEqual(data[:8], b"\x89PNG\r\n\x1a\n", f"{name} no es PNG valido")


class TestFrontendQualityAndSecurity(unittest.TestCase):
    def test_zero_emojis_in_ui_and_src(self):
        emoji_re = re.compile(r"[\U0001F300-\U0001FAFF\u2600-\u27BF]")
        targets = [ROOT / "index.html", *sorted((ROOT / "src").glob("*.js")), ROOT / "src" / "styles.css"]
        for path in targets:
            txt = path.read_text(encoding="utf-8")
            found = emoji_re.findall(txt)
            self.assertEqual(found, [], f"Se encontraron emojis en {path.name}: {found}")

    def test_no_innerhtml_in_src(self):
        unsafe_re = re.compile(r"\.(?:innerHTML|outerHTML|insertAdjacentHTML)\b")
        for js in sorted((ROOT / "src").glob("*.js")):
            txt = js.read_text(encoding="utf-8")
            self.assertIsNone(unsafe_re.search(txt), f"Uso inseguro de DOM HTML en {js.name}")

    def test_sim_engine_math_in_node(self):
        code = """
        import {
          stormIntensityFactor,
          scaleToParanaRise,
          scaleToSaladoRise,
          isRiverElevated,
          WATER_THRESHOLDS,
        } from './src/sim-engine.js';
        import { isValidRiverStage } from './src/live-data.js';

        let sumU = 0, sumC = 0;
        const N = 1000;
        for (let i = 0; i < N; i++) {
          const p = (i + 0.5) / N;
          sumU += stormIntensityFactor(p, 'uniform');
          sumC += stormIntensityFactor(p, 'convective');
        }
        const avgU = sumU / N, avgC = sumC / N;
        if (Math.abs(avgU - 1.0) > 1e-4) throw new Error('uniform integral != 1: ' + avgU);
        if (Math.abs(avgC - 1.0) > 1e-3) throw new Error('convective integral != 1: ' + avgC);
        if (WATER_THRESHOLDS.VISIBLE_M !== 0.04 || WATER_THRESHOLDS.MED_M !== 0.15 || WATER_THRESHOLDS.DEEP_M !== 0.40) {
          throw new Error('Unexpected thresholds');
        }

        // Verificar continuidad C0 (ausencia de saltos > 1 cm al avanzar de a 0.005 m)
        for (let s = 2.0; s <= 7.99; s += 0.005) {
          const dp = Math.abs(scaleToParanaRise(s + 0.005) - scaleToParanaRise(s));
          const ds = Math.abs(scaleToSaladoRise(s + 0.005) - scaleToSaladoRise(s));
          if (dp > 0.01) throw new Error(`Discontinuidad en Paraná alrededor de ${s.toFixed(3)}: dp=${dp}`);
          if (ds > 0.01) throw new Error(`Discontinuidad en Salado alrededor de ${s.toFixed(3)}: ds=${ds}`);
        }
        if (isRiverElevated(3.30, 3.20)) throw new Error('Ríos normales no deben figurar elevados');
        if (!isRiverElevated(5.30, 3.20)) throw new Error('Paraná en alerta debe figurar elevado');

        // Verificar filtro de valores centinela corruptos del INA
        if (isValidRiverStage(-9999) || isValidRiverStage(99.9) || isValidRiverStage(null)) {
          throw new Error('Filtro hidrométrico aceptó valor inválido');
        }
        if (!isValidRiverStage(5.83) || !isValidRiverStage(0.25)) {
          throw new Error('Filtro hidrométrico rechazó valor válido');
        }
        console.log('OK sim-engine & live-data math:', avgU.toFixed(4), avgC.toFixed(4));
        """
        res = subprocess.run(["node", "--input-type=module", "-e", code], cwd=str(ROOT), capture_output=True, text=True)
        self.assertEqual(res.returncode, 0, res.stderr)

    def test_js_syntax_all_modules(self):
        for js in sorted((ROOT / "src").glob("*.js")):
            res = subprocess.run(["node", "--check", str(js)], capture_output=True, text=True)
            self.assertEqual(res.returncode, 0, f"Error de sintaxis en {js.name}: {res.stderr}")

    def test_default_layers_unchecked_and_no_carto(self):
        html = (ROOT / "index.html").read_text(encoding="utf-8")
        m = re.search(r'<input[^>]*id="chk-risk-layer"[^>]*>', html)
        self.assertIsNotNone(m, "Falta el checkbox chk-risk-layer en index.html")
        self.assertNotIn("checked", m.group(0), "chk-risk-layer debe iniciar desactivado por defecto")
        for removed in ("chk-osm-salud", "chk-osm-escuelas", "chk-osm-emerg", "pill-salud", "pill-esc", "pill-emerg"):
            self.assertNotIn(removed, html, f"{removed} fue removido y no debe existir en index.html")
        self.assertRegex(html, r'<button[^>]*data-preset="top"[^>]*class="[^"]*active[^"]*"')
        self.assertRegex(html, r'<option[^>]*value="top"[^>]*selected')
        self.assertRegex(html, r'<button[^>]*class="[^"]*active[^"]*"[^>]*data-wvis="uncertainty"')
        self.assertRegex(html, r'<button[^>]*class="[^"]*active[^"]*"[^>]*data-base="sat"')
        self.assertIn('id="sim-banner"', html)
        self.assertIn('id="sl-recreo"', html)
        self.assertNotIn("Sin riesgo", html)
        self.assertNotIn("Sin riesgo", (ROOT / "src" / "ui.js").read_text(encoding="utf-8"))
        for js in sorted((ROOT / "src").glob("*.js")):
            txt = js.read_text(encoding="utf-8")
            self.assertNotIn("cartocdn.com", txt, f"Referencia rota cartocdn.com en {js.name}")

    def test_validar_eventos_mass_balance(self):
        res = subprocess.run([sys.executable, str(ROOT / "scripts" / "validar_eventos.py")], cwd=str(ROOT), capture_output=True, text=True)
        self.assertEqual(res.returncode, 0, res.stdout + "\n" + res.stderr)
        errors = [float(x) for x in re.findall(r"Error:\s*([0-9.]+)%", res.stdout)]
        self.assertGreaterEqual(len(errors), 2, res.stdout)
        for err in errors:
            self.assertLess(err, 1.0)
        self.assertIn("[Test C - Eventos historicos]", res.stdout)
        self.assertNotIn("omitido", res.stdout)

    def test_current_flood_realism_at_580_586_291(self):
        """Verifica que con Parana 5,80 m, Salado Sto. Tome 5,86 m y Recreo 2,91 m no haya efecto banera ni anillos defendidos sumergidos."""
        from validar_eventos import decode_png_rgba

        with tempfile.TemporaryDirectory() as tmp:
            td = Path(tmp)
            for name in ("dem", "layers", "acum"):
                (td / f"{name}.rgba").write_bytes(decode_png_rgba(ROOT / "assets" / f"{name}.png"))
            js = f"""
            import fs from "node:fs";
            import path from "node:path";
            import {{ createSimEngine }} from "{(ROOT / 'src' / 'sim-engine.js').resolve().as_uri()}";
            const cfgRaw = JSON.parse(fs.readFileSync("./config/region_santa_fe.json", "utf8"));
            const bb = cfgRaw.bbox, gr = cfgRaw.grid, hy = cfgRaw.hydrometry;
            const cfg = {{
              W: gr.w, H: gr.h, MW: gr.mw, MH: gr.mh, SW: gr.sw, SH: gr.sh,
              lonMin: bb.lon_min, lonMax: bb.lon_max, latMin: bb.lat_min, latMax: bb.lat_max,
              worldW: bb.world_w_km, worldH: bb.world_h_km, demMin: gr.dem_min_m, demMax: gr.dem_max_m,
              PARANA_NORMAL: hy.parana_normal_m, SALADO_NORMAL: hy.salado_normal_m
            }};
            const demRGBA = fs.readFileSync(path.join({json.dumps(str(td))}, "dem.rgba"));
            const layersRGBA = fs.readFileSync(path.join({json.dumps(str(td))}, "layers.rgba"));
            const acumRGBA = fs.readFileSync(path.join({json.dumps(str(td))}, "acum.rgba"));
            const heightsM = new Float32Array(cfg.MW * cfg.MH);
            for (let i = 0; i < cfg.MW * cfg.MH; i++) {{
              heightsM[i] = cfg.demMin + (((demRGBA[i*4]<<8)|demRGBA[i*4+1])/65535.0)*(cfg.demMax-cfg.demMin);
            }}
            const sim = createSimEngine({{
              cfg, heightsM, layersRGBA, acumRGBA,
              cityPumps: JSON.parse(fs.readFileSync("./assets/city_pumps.json", "utf8")),
              osmLines: JSON.parse(fs.readFileSync("./assets/osm_lines.json", "utf8")),
              researchOverrides: {{
                defensas: JSON.parse(fs.readFileSync("./config/defensas.json", "utf8")),
              }},
            }});
            sim.state.paranaScale = 5.80;
            sim.state.saladoScale = 5.86;
            sim.state.recreoScale = 2.91;
            sim.stepSubsteps(240, false);

            if (sim.state.resFillPct !== 0) throw new Error("Reservorios deben estar desacoplados del Salado: " + sim.state.resFillPct);
            if (sim.state.urbanFloodHa !== 0) throw new Error("Casco urbano defendido debe estar seco: " + sim.state.urbanFloodHa);
            if (sim.state.extFloodHa < 5000) throw new Error("Valle aluvial extramuros debe reflejar crecida: " + sim.state.extFloodHa);

            const dryMust = [
              ["Reservorios Oeste", -60.7450, -31.5889],
              ["Reservorio Norte", -60.7526, -31.5726],
              ["Relleno Sanitario", -60.7540, -31.5942],
              ["Terraza Salado frente a Relleno (sin onda Recreo)", -60.7640, -31.5930],
              ["Alto Verde Centro", -60.6980, -31.6650],
              ["Alto Verde Sector CAI 1", -60.7001, -31.6589],
              ["Alto Verde Sector CAI 2", -60.6929, -31.6772],
              ["Colastiné Sur (casco defendido)", -60.6045, -31.6630],
              ["La Guardia (anillo La Costa)", -60.6315, -31.6425],
              ["El Pozo / UNL", -60.6605, -31.6365],
              ["Colastiné Norte", -60.6060, -31.6250],
              ["San José del Rincón", -60.5700, -31.6060],
              ["Puerto / Diques", -60.7038, -31.6495],
            ];
            for (const [name, lon, lat] of dryMust) {{
              const u = (lon - cfg.lonMin) / (cfg.lonMax - cfg.lonMin);
              const v = (cfg.latMax - lat) / (cfg.latMax - cfg.latMin);
              const wCm = Math.round(sim.sampleWaterAtUV(u, v) * 100);
              if (wCm > 0) throw new Error(`${{name}} debe estar seco (0 cm), obtuvo ${{wCm}} cm`);
            }}
            """
            mp = td / "check_580.mjs"
            mp.write_text(js, encoding="utf-8")
            res = subprocess.run(["node", str(mp)], cwd=str(ROOT), capture_output=True, text=True)
            self.assertEqual(res.returncode, 0, res.stderr)

    def test_bugfix_entre_rios_and_river_isolation(self):
        """Verifica que la barranca entrerriana nunca reciba agua y que Salado alto con Parana normal no inunde el valle del Parana."""
        from validar_eventos import decode_png_rgba

        with tempfile.TemporaryDirectory() as tmp:
            td = Path(tmp)
            for name in ("dem", "layers", "acum"):
                (td / f"{name}.rgba").write_bytes(decode_png_rgba(ROOT / "assets" / f"{name}.png"))
            js = f"""
            import fs from "node:fs";
            import path from "node:path";
            import {{ createSimEngine }} from "{(ROOT / 'src' / 'sim-engine.js').resolve().as_uri()}";
            const cfgRaw = JSON.parse(fs.readFileSync("./config/region_santa_fe.json", "utf8"));
            const bb = cfgRaw.bbox, gr = cfgRaw.grid, hy = cfgRaw.hydrometry;
            const cfg = {{
              W: gr.w, H: gr.h, MW: gr.mw, MH: gr.mh, SW: gr.sw, SH: gr.sh,
              lonMin: bb.lon_min, lonMax: bb.lon_max, latMin: bb.lat_min, latMax: bb.lat_max,
              worldW: bb.world_w_km, worldH: bb.world_h_km, demMin: gr.dem_min_m, demMax: gr.dem_max_m,
              PARANA_NORMAL: hy.parana_normal_m, SALADO_NORMAL: hy.salado_normal_m
            }};
            const demRGBA = fs.readFileSync(path.join({json.dumps(str(td))}, "dem.rgba"));
            const layersRGBA = fs.readFileSync(path.join({json.dumps(str(td))}, "layers.rgba"));
            const acumRGBA = fs.readFileSync(path.join({json.dumps(str(td))}, "acum.rgba"));
            const heightsM = new Float32Array(cfg.MW * cfg.MH);
            for (let i = 0; i < cfg.MW * cfg.MH; i++) {{
              heightsM[i] = cfg.demMin + (((demRGBA[i*4]<<8)|demRGBA[i*4+1])/65535.0)*(cfg.demMax-cfg.demMin);
            }}
            const sim = createSimEngine({{
              cfg, heightsM, layersRGBA, acumRGBA,
              cityPumps: JSON.parse(fs.readFileSync("./assets/city_pumps.json", "utf8")),
              osmLines: JSON.parse(fs.readFileSync("./assets/osm_lines.json", "utf8")),
              researchOverrides: {{
                defensas: JSON.parse(fs.readFileSync("./config/defensas.json", "utf8")),
                bombeo_capacidades: JSON.parse(fs.readFileSync("./config/bombeo_capacidades.json", "utf8")),
              }},
            }});

            // 1) Crecida extrema (Parana 7,10 + Salado 7,30 + 120 mm) -> luego bajar Parana a 3,28 m
            sim.state.paranaScale = 7.10;
            sim.state.saladoScale = 7.30;
            sim.state.targetMm = 120;
            sim.state.durationHr = 2.5;
            sim.state.drainMode = "saturated";
            sim.state.running = true;
            sim.stepSubsteps(200, true);

            // Barranca Entre Rios debe estar 100% seca incluso con 120 mm
            const uEr = (-60.560 - cfg.lonMin) / (cfg.lonMax - cfg.lonMin);
            const vEr = (cfg.latMax - (-31.710)) / (cfg.latMax - cfg.latMin);
            const erCm = Math.round(sim.sampleWaterAtUV(uEr, vEr) * 100);
            if (erCm > 0) throw new Error("Barranca Entre Rios no debe acumular agua: " + erCm + " cm");

            // Bajar Parana a 3,28 m y reconciliar: valle del Parana (isla este) no debe quedar con > 70 cm
            sim.state.paranaScale = 3.28;
            sim.reconcileRiverDrop();
            const uIsl = (-60.625 - cfg.lonMin) / (cfg.lonMax - cfg.lonMin);
            const vIsl = (cfg.latMax - (-31.658)) / (cfg.latMax - cfg.latMin);
            const islCm = Math.round(sim.sampleWaterAtUV(uIsl, vIsl) * 100);
            if (islCm > 75) throw new Error("Agua del Parana quedo congelada tras bajar slider a 3,28 m: " + islCm + " cm");

            // 2) Sin lluvia, Salado 7,30 m + Parana normal 3,28 m: isla del Parana debe estar seca (sin fuga BFS)
            sim.resetWaterOnly();
            sim.state.paranaScale = 3.28;
            sim.state.saladoScale = 7.30;
            sim.stepSubsteps(120, false);
            const islNoRainCm = Math.round(sim.sampleWaterAtUV(uIsl, vIsl) * 100);
            if (islNoRainCm > 0) throw new Error("Salado se filtro por el cauce del Parana normal: " + islNoRainCm + " cm");
            """
            mp = td / "check_bugs.mjs"
            mp.write_text(js, encoding="utf-8")
            res = subprocess.run(["node", str(mp)], cwd=str(ROOT), capture_output=True, text=True)
            self.assertEqual(res.returncode, 0, res.stderr)


class TestScriptsBehavior(unittest.TestCase):
    def test_live_data_meaningful_change_ignores_timestamp(self):
        live = json.loads((ROOT / "datos_en_vivo.json").read_text(encoding="utf-8"))
        same = copy.deepcopy(live)
        same["actualizado_utc"] = "2099-01-01T00:00:00+00:00"
        same["clima"]["fecha_local"] = "2099-01-01T12:00"
        self.assertFalse(adv.has_meaningful_change(live, same))

        changed = copy.deepcopy(live)
        changed["rios"]["parana_santa_fe"]["valor_m"] = 6.12
        self.assertTrue(adv.has_meaningful_change(live, changed))

    def test_live_data_all_fail_returns_nonzero_without_overwriting(self):
        orig = (ROOT / "datos_en_vivo.json").read_bytes()
        with mock.patch.object(adv, "fetch_ina_series", side_effect=RuntimeError("down")), \
             mock.patch.object(adv, "fetch_open_meteo", side_effect=RuntimeError("down")):
            rc = adv.main(["--dry-run"])
        self.assertEqual(rc, 1)
        self.assertEqual((ROOT / "datos_en_vivo.json").read_bytes(), orig)

    def test_osm_helpers(self):
        self.assertTrue(dosm.is_entre_rios(-60.58, -31.70))
        self.assertFalse(dosm.is_entre_rios(-60.70, -31.64))
        self.assertGreater(dosm.compute_line_length_m([[-60.70, -31.64], [-60.71, -31.64]]), 900.0)
        clipped = saj.clip_polyline_uv([[0.5, 0.9], [0.6, 1.2]])
        self.assertEqual(len(clipped), 2)
        self.assertAlmostEqual(clipped[1][1], 1.0, places=6)

    def test_ina_stage_bounds_filter(self):
        self.assertTrue(adv.is_valid_river_stage(5.83))
        self.assertTrue(adv.is_valid_river_stage(-0.4))
        self.assertFalse(adv.is_valid_river_stage(-9999))
        self.assertFalse(adv.is_valid_river_stage(42.0))
        self.assertFalse(adv.is_valid_river_stage(None))

    def test_offline_script_escapes_closing_script_tag(self):
        payload = {"evil": "Escuela </script><script>alert(1)</script>", "comment": "<!-- test"}
        encoded = boff.safe_json_for_inline_script(payload)
        self.assertNotIn("</script>", encoded.lower())
        self.assertNotIn("<!--", encoded)
        # Sigue siendo una expresion JS valida que devuelve el objeto original
        code = f"const x = {encoded}; if (x.evil !== {json.dumps(payload['evil'])}) process.exit(1);"
        res = subprocess.run(["node", "-e", code], capture_output=True, text=True)
        self.assertEqual(res.returncode, 0, res.stderr)

    def test_offline_bundle_builds_valid_js(self):
        subprocess.run([sys.executable, str(ROOT / "scripts" / "build_offline.py")], check=True)
        out_html = (ROOT / "dist" / "visor_offline.html").read_text(encoding="utf-8")
        scripts = [s for s in re.findall(r"<script(?:\s[^>]*)?>(.*?)</script>", out_html, re.S) if s.strip()]
        self.assertEqual(len(scripts), 1)
        with tempfile.NamedTemporaryFile("w", suffix=".js", encoding="utf-8", delete=False) as tf:
            tf.write(scripts[0])
            js_path = Path(tf.name)
        try:
            res = subprocess.run(["node", "--check", str(js_path)], capture_output=True, text=True)
            self.assertEqual(res.returncode, 0, res.stderr)
        finally:
            js_path.unlink(missing_ok=True)


if __name__ == "__main__":
    unittest.main()
