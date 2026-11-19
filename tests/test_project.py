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
import descargar_osm as dosm  # noqa: E402


class TestConfigAndAssets(unittest.TestCase):
    def test_region_config_schema(self):
        cfg = json.loads((ROOT / "config" / "region_santa_fe.json").read_text(encoding="utf-8"))
        for key in ("bbox", "grid", "entre_rios_filter", "hydrometry", "weather", "places", "research_overrides"):
            self.assertIn(key, cfg)
        self.assertEqual(len(cfg["hydrometry"]["stations"]), 3)
        self.assertGreaterEqual(len(cfg["places"]), 19)
        self.assertGreaterEqual(sum(1 for p in cfg["places"] if p.get("barrio_ref")), 19)

    def test_geojson_and_assets_sync(self):
        eq_gj = json.loads((ROOT / "datos/vectores/osm_equipamiento_critico.geojson").read_text(encoding="utf-8"))
        ln_gj = json.loads((ROOT / "datos/vectores/osm_canales_defensas.geojson").read_text(encoding="utf-8"))
        pm_gj = json.loads((ROOT / "datos/vectores/estaciones_bombeo_aprox.geojson").read_text(encoding="utf-8"))
        rs_gj = json.loads((ROOT / "datos/vectores/reservorios_santa_fe.geojson").read_text(encoding="utf-8"))

        eq_as = json.loads((ROOT / "assets/osm_facilities.json").read_text(encoding="utf-8"))
        ln_as = json.loads((ROOT / "assets/osm_lines.json").read_text(encoding="utf-8"))
        pm_as = json.loads((ROOT / "assets/city_pumps.json").read_text(encoding="utf-8"))

        self.assertEqual(len(eq_gj["features"]), len(eq_as))
        self.assertEqual(len(ln_gj["features"]), len(ln_as))
        self.assertEqual(len(pm_gj["features"]), len(pm_as))
        self.assertGreater(len(rs_gj["features"]), 0)

        for f in eq_gj["features"]:
            self.assertIn("cota_fabdem_m", f["properties"])
        for f in ln_gj["features"]:
            self.assertIn("longitud_m", f["properties"])
            self.assertIn("cota_media_fabdem_m", f["properties"])
        for f in pm_gj["features"]:
            self.assertIn("cota_fabdem_m", f["properties"])

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
        import { stormIntensityFactor, WATER_THRESHOLDS } from './src/sim-engine.js';
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
        console.log('OK sim-engine math:', avgU.toFixed(4), avgC.toFixed(4));
        """
        res = subprocess.run(["node", "--input-type=module", "-e", code], cwd=str(ROOT), capture_output=True, text=True)
        self.assertEqual(res.returncode, 0, res.stderr)

    def test_js_syntax_all_modules(self):
        for js in sorted((ROOT / "src").glob("*.js")):
            res = subprocess.run(["node", "--check", str(js)], capture_output=True, text=True)
            self.assertEqual(res.returncode, 0, f"Error de sintaxis en {js.name}: {res.stderr}")


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
