// Estrategia baseline: solo UT Bot.
//
// Long-only, una posición a la vez. Reglas:
//   - Buy signal en bar i, sin posición -> abrir long al next bar's open
//     (el engine maneja el lag via pendingEntry).
//     Stop = trailingStop[i] al momento de la señal.
//     Tamaño $5, leverage 5x. Sin TP (salida solo por signal-flip).
//   - Sell signal con posición long abierta -> cerrar al close del bar (engine
//     traduce {action:'close'} a exit con slippage).
//   - Sell sin posición -> ignorado (no shorts en V1).
//
// Esta estrategia NO valida el mínimo de orden de Binance (~$9 nominal). Eso
// se enforce en el live trader, no en el backtester. Documentado en design.
//
// ESM puro.

import { utBot } from "../../indicators.js";

export const utBotOnly = {
  name: "utBotOnly",

  /**
   * Precomputa señales UT Bot sobre toda la ventana y construye un lookup O(1)
   * por bar index. Los trailing stops también vienen como array, uno por bar.
   *
   * @param {Array<{openTime:number,high:number,low:number,close:number}>} klines
   * @param {{utAtr?:number, utKey?:number, [k:string]:any}} [options]
   */
  init(klines, options = {}) {
    const result = utBot(klines, {
      atrPeriod: options.utAtr ?? 10,
      keyValue: options.utKey ?? 2,
    });

    const signalAt = new Array(klines.length).fill(null);
    for (const sig of result.signals) {
      signalAt[sig.index] = sig.type;
    }

    return {
      signalAt,
      trailingStops: result.trailingStop, // alias semántico
      trailingStop: result.trailingStop,
      utBotResult: result,
    };
  },

  /**
   * @param {{openTime:number,open:number,high:number,low:number,close:number}} bar
   * @param {{
   *   i:number,
   *   klines:Array,
   *   position:object|null,
   *   state:{signalAt:Array<string|null>,trailingStops:number[]},
   *   options?:object
   * }} ctx
   * @returns {{action:string, side?:string, stopPrice?:number, tpPrice?:number, sizeUSDT?:number, leverage?:number} | null}
   */
  onBar(bar, ctx) {
    const sig = ctx.state.signalAt[ctx.i];

    if (sig === "Buy" && !ctx.position) {
      const stop = ctx.state.trailingStops[ctx.i];
      if (!Number.isFinite(stop)) return null; // ATR no semilleado todavía
      return {
        action: "open",
        side: "long",
        stopPrice: stop,
        tpPrice: null, // sin TP, salida solo por signal-flip
        sizeUSDT: ctx.options?.positionSizeUSDT ?? 5,
        leverage: ctx.options?.leverage ?? 5,
      };
    }

    if (sig === "Sell" && ctx.position && ctx.position.side === "long") {
      return { action: "close" };
    }

    return null;
  },
};

export default utBotOnly;
