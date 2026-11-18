# Santa Fe 3D — Simulador de Lluvias, Crecidas y Bombeo

Visor topográfico 3D interactivo y análisis de acumulación hídrica para la ciudad de Santa Fe y su área metropolitana (Río Paraná / Laguna Setúbal, Río Salado, reservorios y estaciones de bombeo).

**Abrir el visor online (GitHub Pages):**
`https://trepagaspar.github.io/lluvias_y_crecidas_simulador/`

---

## Qué incluye este repositorio

* **`visor_3d_santa_fe.html`** (y `index.html`): Simulador 3D WebGL2 interactivo con:
  * **Datos en vivo (gratuitos):** consulta automática de alturas oficiales de ríos desde la API del **INA** (`alerta.ina.gob.ar/a5`, Puerto Santa Fe `series_id=30` y Río Salado en Santo Tomé `series_id=3044`) y pronóstico de lluvia a 48 h desde **Open-Meteo** (`api.open-meteo.com`).
  * **Escalas hidrométricas reales:** sliders calibrados en metros de escala oficial (Puerto SF: Alerta 5,30 m / Evacuación 5,70 m · Salado Sto. Tomé: Alerta 4,70 m).
  * **59 estaciones de bombeo** (`estaciones_bombeo_aprox.geojson`, ubicación aproximada calcada del mapa de referencia) con encendido/apagado para evaluar su impacto por subcuenca conectada y reservorios.
  * **Escenarios rápidos**, consulta puntual por barrio, descarga de lluvia puntual, bombas manuales y recorrido guiado de 5 pasos.
* **`scripts/actualizar_datos_vivo.py`** + **`datos_en_vivo.json`** + **`.github/workflows/actualizar_datos.yml`**: actualización automática cada 6 horas vía GitHub Actions como respaldo rápido para el visor web.
* **Capas SIG y documentación:** modelos MDE IGN (~30 m), acumulación de flujo, zonificación de riesgo hídrico (`riesgo hidrico - Santa Fe ciudad.gpkg`), reservorios, equipamiento, `estaciones_bombeo_aprox.geojson` e `informe Julio 26.docx`.

## Activar GitHub Pages (única vez)

1. Ir a **Settings → Pages** en este repositorio (`https://github.com/trepagaspar/lluvias_y_crecidas_simulador/settings/pages`).
2. En **Build and deployment → Source**, elegir **Deploy from a branch**.
3. Seleccionar rama **`main`** y carpeta **`/ (root)`**, luego clic en **Save**.
4. En ~1 minuto quedará publicado en `https://trepagaspar.github.io/lluvias_y_crecidas_simulador/`.

## Aviso técnico

Modelo hidro-topográfico orientativo basado en MDE satelital (~30 m) y simulación celular simplificada. No modela conductos pluviales subterráneos ni cotas de compuertas y **no reemplaza partes ni alertas oficiales** de Prefectura Naval Argentina, INA, FICH-UNL o Protección Civil.
