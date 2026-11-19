# Santa Fe 3D — Simulador de Lluvias, Crecidas y Bombeo (v2)

Visor topográfico 3D interactivo y simulador hidrológico modular para el Gran Santa Fe (Río Paraná / Laguna Setúbal, Río Salado, reservorios, defensas, 59 estaciones de bombeo y equipamiento crítico).

**Visor online (GitHub Pages):**
`https://trepagaspar.github.io/lluvias_y_crecidas_simulador/`

---

## Arquitectura y mejoras v2

* **Interfaz "Cartographic Dark Telemetry":** diseño limpio con mapa protagonista (≥ 85% del viewport), iconografía SVG monocroma (cero emojis), 3 zonas sin solapamientos (Command Bar + Panel lateral con rail `Simular / Capas / Impacto` + Dock inferior), leyenda oscura colapsable completa y soporte móvil (`<= 920px`).
* **Relieve suelo desnudo + hidrología D8 continua (FABDEM V1-2 ~30 m):** assets binarios desacoplados en `assets/` (`dem.png`, `layers.png`, `acum.png`) cacheables por HTTP, con reconstrucción 100% reproducible desde vectores fuente en `datos/vectores/`.
* **Motor WebGL2 optimizado y física consistente:** renderizado bajo demanda (*dirty flag*, ~0% GPU en reposo), `dt` independiente de la tasa de refresco (60/120/144 Hz), conservación de masa de lluvia, hietograma *Uniforme / Convectiva*, humedad previa automática (desde lluvia 24 h Open-Meteo), rugosidad Manning diferenciada, 93 canales y 15 defensas OSM integrados en la grilla dinámica y drenaje en los 4 bordes.
* **Datos en vivo resilientes (INA + Open-Meteo):** consulta en tiempo real de Paraná (Puerto SF `series_id=30`), Salado (Santo Tomé `series_id=3044` y Recreo RP70 `series_id=103`) con sparklines de 7 días y lluvia 24 h / pronóstico 48 h, con fallback independiente por fuente hacia `datos_en_vivo.json`.
* **Deep-linking compartible y seguridad:** botón **Compartir** con URL completa del escenario (`vista`, `parana`, `salado`, `lluvia`, `duracion`, `saturado`, `bombeo`, `perfil`), cero uso de `innerHTML` con datos externos (protección XSS) y versión portable offline opcional (`dist/visor_offline.html`).

---

## Estructura del repositorio

```text
.
├── index.html                        # Entrypoint directo del visor 3D (con OpenGraph y favicon)
├── visor_3d_santa_fe.html            # Redirección compatible con enlaces previos
├── datos_en_vivo.json                # Caché automático cada 6 h (INA + Open-Meteo)
├── config/
│   ├── region_santa_fe.json          # Fuente única de verdad (BBOX, grillas, estaciones, lugares)
│   └── README_research.md            # Contratos JSON data-driven para Fase 6 (post-research)
├── src/                              # Frontend modular ES (sin framework, sin bundler requerido)
│   ├── styles.css                    # Design system Cartographic Dark Telemetry + responsive
│   ├── icons.js                      # Iconos SVG Lucide + sparklines 7 días
│   ├── format.js                     # Formateo es-AR uniforme + helper DOM seguro
│   ├── live-data.js                  # INA + Open-Meteo con fallback parcial independiente
│   ├── sim-engine.js                 # Motor hidráulico conservativo con dt real y Manning
│   ├── webgl-renderer.js             # WebGL2 on-demand, picking cacheado y basemaps
│   ├── story.js                      # Recorrido guiado dinámico de 5 pasos
│   ├── ui.js                         # Controlador HUD de 3 zonas y deep-linking
│   └── main.js                       # Bootstrap modular (HTTP + soporte bundle offline)
├── assets/                           # Rasters PNG y JSON compactos servidos con caché HTTP
├── scripts/
│   ├── actualizar_datos_vivo.py      # INA + Open-Meteo -> datos_en_vivo.json (sin commits vacíos)
│   ├── descargar_osm.py              # Overpass API -> GeoJSONs preservando cotas FABDEM
│   ├── sync_assets_json.py           # Sincroniza assets/*.json desde datos/vectores/ (stdlib)
│   ├── construir_visor_fabdem.py     # Pipeline GIS reproducible desde FABDEM + vectores fuente
│   └── build_offline.py              # Genera dist/visor_offline.html autocontenido (file://)
├── tests/
│   └── test_project.py               # Suite unitaria, seguridad, sincronía y sintaxis JS
└── .github/workflows/
    ├── actualizar_datos.yml          # Cron 6 h: actualiza datos_en_vivo.json solo si hay cambios
    ├── actualizar_osm.yml            # Cron mensual: actualiza OSM + assets/*.json en rama bot/osm-update
    ├── verificar_visor.yml           # CI: Python + tests unitarios + sintaxis JS + seguridad
    └── deploy_pages.yml              # Deploy liviano (< 5 MB) en GitHub Pages
```

## Comandos locales útiles

```powershell
# Ejecutar servidor local para probar el visor modular
python -m http.server 8000

# Correr suite completa de pruebas (sintaxis, sincronía, seguridad, bundle offline)
python -m unittest discover -s tests -v

# Generar versión portable de un solo archivo (dist/visor_offline.html)
python scripts/build_offline.py

# Reconstruir assets desde FABDEM + vectores fuente (QGIS / GDAL)
& "C:\Program Files\QGIS 3.40.13\bin\python-qgis-ltr.bat" scripts/construir_visor_fabdem.py
```

## Aviso técnico

Modelo hidro-topográfico orientativo basado en MDE suelo desnudo FABDEM (~30 m), capas abiertas de OpenStreetMap y simulación celular simplificada. No modela conductos pluviales subterráneos ni maniobras de compuertas y **no reemplaza partes ni alertas oficiales** de Prefectura Naval Argentina, INA, FICH-UNL o Protección Civil.
