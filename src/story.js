// Recorrido guiado de 5 pasos — dinámico con liveState (sin alturas congeladas ni emojis).
import { fmtNum } from "./format.js";

export function createStorySteps({ cfg, liveState, sim, renderer, actions }) {
  return [
    {
      title: "1/5 · Ciudad rodeada por dos ríos",
      text: "Santa Fe se ubica entre el Río Salado (oeste) y el sistema Laguna Setúbal / Río Paraná (este). Su casco urbano central es más alto que las islas y el valle fluvial que lo rodea.",
      action: () => {
        renderer.setPreset("cap2");
        actions.resetAll();
      },
    },
    {
      title: "2/5 · Los caminos ocultos del agua",
      text: "Las trazas azules muestran por dónde busca bajar el agua de lluvia por gravedad. En barrios del Noroeste sin red completa de desagües, estos corredores concentran el escurrimiento.",
      action: () => {
        renderer.flyTo(-60.732, -31.578, -0.45, 0.58, 9.2);
      },
    },
    {
      title: "3/5 · El rol de los reservorios",
      text: "Los cuencos y reservorios (borde turquesa) reciben primero el agua de la ciudad ante una tormenta de 90 mm, amortiguando anegamientos en calles cercanas.",
      action: () => {
        renderer.setPreset("res");
        actions.applyCustomScenario({
          rain: 90,
          dur: 2.0,
          parana: cfg.PARANA_NORMAL,
          salado: cfg.SALADO_NORMAL,
          drainMode: "partial",
          runRain: true,
        });
      },
    },
    {
      getTitle: () =>
        `4/5 · Ríos actuales (${fmtNum(liveState.parana, 2)} / ${fmtNum(liveState.salado, 2)} m) vs. defensas`,
      getText: () =>
        `Con el Paraná en ${fmtNum(liveState.parana, 2)} m (Alerta 5,30 m · Evacuación 5,70 m) y el Salado en ${fmtNum(liveState.salado, 2)} m (Alerta 4,70 m), el agua ocupa bañados e islas bajas sin defensa, mientras el anillo defensivo y las cotas altas protegen la ciudad.`,
      action: () => {
        renderer.setPreset("costa");
        actions.applyCustomScenario({
          rain: 0,
          dur: 2.0,
          parana: liveState.parana,
          salado: liveState.salado,
          drainMode: "partial",
          settleRiverSubsteps: 270,
        });
      },
    },
    {
      title: "5/5 · Efecto tapón: lluvia con río alto",
      text: "Si llueven 120 mm mientras los ríos están crecidos (6,50 m), el agua urbana pierde capacidad de salida por gravedad y depende de los reservorios y las 59 estaciones de bombeo.",
      action: () => {
        renderer.setPreset("cap2");
        actions.applyCustomScenario({
          rain: 120,
          dur: 2.5,
          parana: 6.5,
          salado: 6.5,
          drainMode: "saturated",
          stormProfile: "convective",
          preRunSubsteps: 225,
        });
      },
    },
  ];
}
