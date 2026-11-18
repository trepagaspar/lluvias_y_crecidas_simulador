# Santa Fe 3D — Simulador de Lluvias, Crecidas y Bombeo

Visor topográfico 3D interactivo y análisis de acumulación hídrica para la ciudad de Santa Fe y su área metropolitana (Río Paraná / Laguna Setúbal, Río Salado, reservorios, defensas, estaciones de bombeo y equipamiento crítico).

**Abrir el visor online (GitHub Pages):**
`https://trepagaspar.github.io/lluvias_y_crecidas_simulador/`

---

## Qué incluye el visor 3D (`visor_3d_santa_fe.html`)

* **Relieve 3D "suelo desnudo" (FABDEM V1-2 ~30 m):** reemplaza el MDE satelital anterior eliminando falsos pozos por techos/árboles y el salto vertical entre hojas IGN (`3160-26` / `3160-32`), con cotas ortométricas reales (Laguna Setúbal ~10,5 m; casco urbano ~17–20 m) y sombreado topográfico multidireccional.
* **Datos en vivo (gratuitos):** consulta automática de alturas oficiales de ríos desde la API del **INA** (`alerta.ina.gob.ar/a5`, Puerto Santa Fe `series_id=30` y Río Salado en Santo Tomé `series_id=3044`) y pronóstico de lluvia a 48 h desde **Open-Meteo** (`api.open-meteo.com`).
* **Escalas hidrométricas reales + anillo de defensas:** sliders calibrados en metros de escala oficial (Puerto SF: `0 = 8,42 m IGN`, Alerta 5,30 m / Evacuación 5,70 m · Salado Sto. Tomé: Alerta 4,70 m), modelando el anillo de defensa urbano y el "efecto tapón" sobre los desagües por gravedad.
* **59 estaciones de bombeo** (`datos/vectores/estaciones_bombeo_aprox.geojson`, ubicación aproximada) con encendido/apagado para evaluar su impacto en subcuencas urbanas y reservorios.
* **Equipamiento crítico y desagües abiertos (OpenStreetMap):**
  * **362 puntos críticos** (`80` centros de salud/hospitales/CAPS, `236` escuelas/jardines/universidades, `46` bomberos/comisarías) con **indicadores en vivo de impacto (>10 cm)** y reporte en el diagnóstico puntual.
  * **116 trazas** (`101` canales/zanjas a cielo abierto y `15` terraplenes/defensas) visibles como capa superpuesta en el 3D.

---

## Estructura del repositorio

```text
.
├── index.html                        # Redirección automática para GitHub Pages
├── visor_3d_santa_fe.html            # Simulador 3D WebGL2 autocontenido
├── datos_en_vivo.json                # Caché actualizado cada 6 h (INA + Open-Meteo)
├── scripts/
│   ├── actualizar_datos_vivo.py      # Consulta API INA + Open-Meteo -> datos_en_vivo.json
│   ├── descargar_osm.py              # Descarga equipamiento crítico y canales/defensas (Overpass API)
│   └── construir_visor_fabdem.py     # Re-genera relieve FABDEM, hillshade y capas OSM en el visor
├── datos/
│   ├── dem/                          # FABDEM suelo desnudo (fabdem_santa_fe.tif), IGN, SRTM, flujo
│   ├── vectores/                     # Riesgo hídrico (.gpkg), bombeo, OSM GeoJSON, reservorios, IGN
│   └── zips_originales/              # Archivos comprimidos originales de respaldo
├── docs/                             # Informe técnico y capturas 3D estáticas
└── .github/workflows/
    ├── actualizar_datos.yml          # Cron cada 6 h: actualiza datos_en_vivo.json
    ├── actualizar_osm.yml            # Cron mensual / manual: actualiza GeoJSONs de OSM
    └── verificar_visor.yml           # CI en cada push: valida GeoJSON, JSON y sintaxis JS del visor
```

## Activar GitHub Pages (única vez)

1. Ir a **Settings → Pages** (`https://trepagaspar.github.io/lluvias_y_crecidas_simulador/` → `Settings → Pages` en GitHub).
2. En **Build and deployment → Source**, elegir **Deploy from a branch**.
3. Seleccionar rama **`main`** y carpeta **`/ (root)`**, luego clic en **Save**.

## Reproducir la construcción del visor (QGIS / GDAL)

```powershell
python scripts/descargar_osm.py
& "C:\Program Files\QGIS 3.40.13\bin\python-qgis-ltr.bat" scripts/construir_visor_fabdem.py
```

## Aviso técnico

Modelo hidro-topográfico orientativo basado en MDE suelo desnudo FABDEM (~30 m), capas abiertas de OpenStreetMap y simulación celular simplificada. No modela conductos pluviales subterráneos ni maniobras de compuertas y **no reemplaza partes ni alertas oficiales** de Prefectura Naval Argentina, INA, FICH-UNL o Protección Civil.
