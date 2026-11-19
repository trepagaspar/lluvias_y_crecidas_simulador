# Contratos de Datos para Fase 6 (Integración con Research)

El motor hidráulico (`src/sim-engine.js`) ya está preparado para consumir parámetros físicos reales de Santa Fe sin modificar el código JavaScript.

Para activar cualquier calibración, colocá el archivo JSON en `config/` y registrá su ruta en `research_overrides` dentro de `config/region_santa_fe.json`:

```json
"research_overrides": {
  "defensas": "./config/defensas.json",
  "bombeo_capacidades": "./config/bombeo_capacidades.json",
  "reservorios": "./config/reservorios.json",
  "eventos_calibracion": "./config/eventos_calibracion.json",
  "puntos_criticos_empiricos": "./config/puntos_criticos_empiricos.json"
}
```

## 1. `config/defensas.json` — Cotas de coronamiento por tramo
```json
{
  "cota_defecto_m": 16.20,
  "tramos": [
    {
      "nombre": "Defensa Oeste (Río Salado)",
      "cota_coronamiento_m": 18.20,
      "fuente": "Plan Director / INA",
      "uv": [[0.28, 0.55], [0.29, 0.70]]
    }
  ]
}
```

## 2. `config/bombeo_capacidades.json` — Caudal real por estación (`m³/s`)
```json
{
  "estaciones": [
    {
      "id": 1,
      "nombre": "EB0 / Estación ejemplo",
      "caudal_m3s": 18.5,
      "reservorio": "Reservorio Oeste"
    }
  ]
}
```

## 3. `config/reservorios.json` — Profundidad útil real
```json
{
  "profundidad_defecto_m": 2.40,
  "cuencos": [
    {
      "id": 1,
      "nombre": "Reservorio Oeste",
      "profundidad_util_m": 2.80,
      "volumen_m3": 1450000
    }
  ]
}
```

## 4. `config/eventos_calibracion.json` — Eventos históricos reales
```json
{
  "eventos": [
    {
      "nombre": "Tormenta Marzo 2007 (referencia)",
      "lluvia_mm": 180,
      "duracion_h": 6.0,
      "perfil": "convective",
      "parana_m": 4.20,
      "salado_m": 4.10,
      "barrios_anegados_reales": ["Santa Rosa de Lima", "Barranquitas", "Centenario"]
    }
  ]
}
```

## 5. `config/puntos_criticos_empiricos.json` — Puntos críticos con umbral observado en campo
```json
{
  "puntos": [
    {
      "id": "alto_verde_la_boca_acceso",
      "nombre": "Camino a La Boca (Alto Verde)",
      "lon": -60.6845,
      "lat": -31.6860,
      "umbral_rio": "parana_santa_fe",
      "umbral_hidrometrico_m": 5.70,
      "umbral_lluvia_mm": null,
      "efecto_operativo": "Camino intransitable / aislamiento vehicular de La Boca",
      "evidencia_campo": "Informe territorial Hábitat · corte verificado con Puerto SF >= 5,70 m",
      "fecha_registro": "2026-11-16"
    }
  ]
}
```
