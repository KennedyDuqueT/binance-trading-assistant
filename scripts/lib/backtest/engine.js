// Backtest engine. Stateless event-loop driven by klines + pluggable strategy.
//
// Contrato:
//   runBacktest({ klines, strategy, options }) => {
//     trades, equityCurve, runId, strategyName, symbol
//   }
//
// Reglas (decisiones del design):
//   - Iteración cronológica ascendente por openTime.
//   - Indicadores precomputados via strategy.init() (UT Bot lookup O(N)).
//   - Una posición abierta a la vez (V1 long-only).
//   - Entrada al "next bar's open" — en V1 la implementamos vía pendingEntry:
//       bar i: strategy emite {action:'open', ...} -> guardamos pendingEntry
//       bar i+1: si pendingEntry, abrimos al open[i+1] con slippage favorable a sí.
//   - Salida por stop/tp via Position.apply -> stop-first rule.
//   - Salida por strategy {action:'close'} -> al close del bar actual con slippage.
//   - Equity per-bar (mark-to-market) para curva fina.
//
// ESM puro. Sin imports externos.

import { Position } from "./position.js";

/**
 * @param {{
 *   klines: Array<{openTime:number,open:number,high:number,low:number,close:number,volume?:number}>,
 *   strategy: { name: string, init?: Function, onBar: Function },
 *   options?: {
 *     initialCapital?: number,
 *     slippageBps?: number,
 *     barIntervalMs?: number,
 *     positionSizeUSDT?: number,
 *     leverage?: number,
 *     [key: string]: any
 *   }
 * }} args
 */
export async function runBacktest({ klines, strategy, options = {} }) {
  if (!Array.isArray(klines) || klines.length === 0) {
    throw new Error("runBacktest: klines vacíos");
  }
  if (!strategy || typeof strategy.onBar !== "function") {
    throw new Error("runBacktest: strategy.onBar es obligatorio");
  }

  // Validar orden ascendente y normalizar (no permitimos huecos sin orden).
  for (let i = 1; i < klines.length; i++) {
    if (klines[i].openTime <= klines[i - 1].openTime) {
      throw new Error(
        `runBacktest: klines no están en orden ascendente (idx ${i})`,
      );
    }
  }

  const slippageBps = options.slippageBps ?? 5;
  const initialCapital = options.initialCapital ?? 144;
  const slip = slippageBps / 10000;

  /** @type {object[]} */
  const trades = [];
  /** @type {Array<{time:number, equity:number}>} */
  const equityCurve = [];

  /** @type {Position | null} */
  let position = null;
  let equity = initialCapital;

  // Strategy init -> indicador precomputado (e.g., utBot signals + trailing stops).
  const stratState =
    typeof strategy.init === "function"
      ? await strategy.init(klines, options)
      : {};

  /** @type {null | {side:'long'|'short', stopPrice:number, tpPrice:number|null, sizeUSDT:number, leverage:number, extras?:object}} */
  let pendingEntry = null;

  for (let i = 0; i < klines.length; i++) {
    const bar = klines[i];

    // 1) Si hay pendingEntry desde el bar anterior, abrir al open de este bar.
    if (pendingEntry && !position) {
      const sideMul = pendingEntry.side === "long" ? 1 : -1;
      // Entrada con slippage desfavorable: long paga arriba, short paga abajo.
      const entryPrice = bar.open * (1 + slip * sideMul);
      position = new Position({
        side: pendingEntry.side,
        entryTime: bar.openTime,
        entryPrice,
        stopPrice: pendingEntry.stopPrice,
        tpPrice: pendingEntry.tpPrice,
        sizeUSDT: pendingEntry.sizeUSDT,
        leverage: pendingEntry.leverage,
        entryBarIdx: i,
      });
      // Adjuntar metadata custom de la estrategia (e.g., confluence, tier)
      // para propagarla al trade record en el cierre. No es campo del Position
      // contract; vive aparte para no contaminar Position.apply().
      if (pendingEntry.extras) {
        position._extras = pendingEntry.extras;
      }
      pendingEntry = null;
    }

    // 2) Aplicar bar a posición existente -> resolver stop/TP.
    if (position) {
      const result = position.apply(bar, slippageBps);
      if (result.status !== "open") {
        const exitReason = result.status === "stopped" ? "stop" : "tp_hit";
        trades.push(_recordTrade(position, result, exitReason, i));
        equity += result.pnlUSDT;
        position = null;
      }
    }

    // 3) Strategy decide.
    const action = strategy.onBar(bar, {
      i,
      barIndex: i,
      klines,
      position,
      state: stratState,
      indicatorState: stratState,
      options,
    });

    if (action && action.action === "close" && position) {
      // Cierre por señal: al close del bar con slippage desfavorable.
      const sideMul = position.side === "long" ? 1 : -1;
      const exitPrice = bar.close * (1 - slip * sideMul);
      const pnlUSDT = position.pnlAt(exitPrice);
      const R = position.rAt(exitPrice);
      trades.push(
        _recordTrade(
          position,
          { exitTime: bar.openTime, exitPrice, pnlUSDT, R },
          "signal_exit",
          i,
        ),
      );
      equity += pnlUSDT;
      position = null;
    } else if (action && action.action === "open" && !position && !pendingEntry) {
      // Open al next bar's open. Validar campos mínimos.
      if (!Number.isFinite(action.stopPrice)) {
        // Strategy no entregó stop -> abortamos esta señal silenciosamente.
        // (El operador sabrá por la métrica si una estrategia genera muchos no-trades.)
      } else {
        // Cualquier campo que la estrategia agregue más allá del Position contract
        // (e.g., confluence, confluenceCount, tier) viaja como `extras` y se
        // propaga al trade record en el cierre.
        const {
          action: _a,
          side: _s,
          stopPrice: _sp,
          tpPrice: _tp,
          sizeUSDT: _su,
          leverage: _l,
          ...extras
        } = action;
        pendingEntry = {
          side: action.side ?? "long",
          stopPrice: action.stopPrice,
          tpPrice: action.tpPrice ?? null,
          sizeUSDT: action.sizeUSDT ?? options.positionSizeUSDT ?? 5,
          leverage: action.leverage ?? options.leverage ?? 5,
          extras: Object.keys(extras).length > 0 ? extras : undefined,
        };
      }
    }

    // 4) Mark-to-market equity para la curva por bar.
    let mtm = equity;
    if (position) {
      mtm = equity + position.pnlAt(bar.close);
    }
    equityCurve.push({ time: bar.openTime, equity: mtm });
  }

  // Si quedó una posición abierta al final del rango, la cerramos al close
  // del último bar con motivo 'eod' (end-of-data) para no perder el trade.
  if (position) {
    const lastBar = klines[klines.length - 1];
    const sideMul = position.side === "long" ? 1 : -1;
    const exitPrice = lastBar.close * (1 - slip * sideMul);
    const pnlUSDT = position.pnlAt(exitPrice);
    const R = position.rAt(exitPrice);
    trades.push(
      _recordTrade(
        position,
        { exitTime: lastBar.openTime, exitPrice, pnlUSDT, R },
        "eod",
        klines.length - 1,
      ),
    );
    equity += pnlUSDT;
    position = null;
  }

  return {
    trades,
    equityCurve,
    runId: null, // CLI lo asigna; mantenemos null aquí para no acoplar engine a wall clock.
    strategyName: strategy.name ?? "anonymous",
    symbol: options.symbol ?? null,
    finalEquity: equity,
  };
}

/**
 * Construye el record de trade con los 13 campos contractados + cualquier
 * metadata custom que la estrategia haya agregado vía `position._extras`.
 *
 * Los extras se spread PRIMERO para que los campos estándar siempre ganen
 * en caso de colisión (no rompemos el contrato del trade record).
 */
function _recordTrade(position, result, exitReason, currentBarIdx) {
  const pnlPct = (result.pnlUSDT / position.sizeUSDT) * 100;
  const holdBars =
    position.entryBarIdx != null ? currentBarIdx - position.entryBarIdx : null;
  const extras = position._extras ?? {};
  return {
    ...extras,
    side: position.side,
    entryTime: position.entryTime,
    entryPrice: position.entryPrice,
    stopPrice: position.stopPrice,
    tpPrice: position.tpPrice,
    exitTime: result.exitTime,
    exitPrice: result.exitPrice,
    exitReason,
    sizeUSDT: position.sizeUSDT,
    leverage: position.leverage,
    pnlUSDT: result.pnlUSDT,
    pnlPct,
    R: result.R,
    holdBars,
  };
}
