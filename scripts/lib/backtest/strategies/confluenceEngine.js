// Confluence Engine V1a — operacionaliza PRD §5 sobre el harness del local-backtester.
//
// Reglas de entrada (3-de-4 confluencias):
//   R1: UT Bot signal en la barra actual (Buy → long, Sell → short).
//   R2: visible LuxAlgo break (B/S, NO wicks) en las últimas `breakWindow` barras
//       (default 3) en la dirección del trade.
//   R3: si R2 verdadero → consume `withVolume` del break R2.
//       si R2 falso     → fallback `bar.volume > 1.2 × SMA(volume, 20)`.
//   R4: si symbol === 'BTCUSDT' → auto-true (no hay BTC "padre").
//       si no → BTC UT Bot pos[i] (per openTime) coincide con dirección del trade.
//              Falta de bar BTC → R4 false (conservador).
//
// Stop híbrido (decisión D8):
//   long  → stopPrice = Math.max(utBotTrailingStop, activeLowPivot.price)
//   short → stopPrice = Math.min(utBotTrailingStop, activeHighPivot.price)
//
// TP único @ 2.5R (V1a). Ladder 50/30/20 deferida a `confluence-engine-tp-ladder`.
//
// Max-loss gate: rechazo si `sizeUSDT × leverage × R / entryClose > 0.03 × initialCapital`
// (V1 simplification: contra capital INICIAL, no equity rolling).
//
// Sizing fijo por tier resuelto en `_tiers.js`. Override CLI vía `--position-size`
// y `--leverage` se prioriza sobre tier (decisión D10).
//
// ESM puro.

import { utBot, luxAlgoSnR } from "../../indicators.js";
import { loadKlinesCached } from "../../klines.js";
import { resolveTier } from "./_tiers.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * SMA simple sobre `values` con período `period`. NaN antes del seed.
 * Reimplementado localmente (en vez de reusar `sma` de indicators.js) para
 * mantener la dependencia explícita y evitar acoplamiento accidental futuro.
 */
function _volSma(values, period) {
  const n = values.length;
  const out = new Array(n).fill(NaN);
  if (period <= 0 || n < period) return out;
  let sum = 0;
  for (let i = 0; i < period; i++) sum += values[i];
  out[period - 1] = sum / period;
  for (let i = period; i < n; i++) {
    sum += values[i] - values[i - period];
    out[i] = sum / period;
  }
  return out;
}

/**
 * Reconstruye `activeHighPivot[i]` y `activeLowPivot[i]` por barra usando la
 * misma semántica de LuxAlgo: pivot detectado en `src` se activa en barra
 * `src + rightBars + 1` (shift `pivothigh(...)[1]`).
 *
 * `pivotHistory` viene ordenado por `index` ascendente (luxAlgoSnR garantiza
 * iteración cronológica), pero ordenamos defensivamente por si cambia.
 */
function _buildActivePivots(N, pivotHistory, rightBars) {
  const activeHigh = new Array(N).fill(null);
  const activeLow = new Array(N).fill(null);
  const sortedHighs = [...pivotHistory.highs].sort((a, b) => a.index - b.index);
  const sortedLows = [...pivotHistory.lows].sort((a, b) => a.index - b.index);

  let lastH = null;
  let lastL = null;
  let hIdx = 0;
  let lIdx = 0;

  for (let j = 0; j < N; j++) {
    while (
      hIdx < sortedHighs.length &&
      sortedHighs[hIdx].index + rightBars + 1 <= j
    ) {
      lastH = sortedHighs[hIdx];
      hIdx++;
    }
    while (
      lIdx < sortedLows.length &&
      sortedLows[lIdx].index + rightBars + 1 <= j
    ) {
      lastL = sortedLows[lIdx];
      lIdx++;
    }
    activeHigh[j] = lastH;
    activeLow[j] = lastL;
  }

  return { activeHigh, activeLow };
}

/**
 * Construye `Map<openTime, btcPos>` cruzando UT Bot sobre BTCUSDT en la misma
 * ventana del par objetivo. Falla silenciosamente y retorna `Map` vacío si la
 * carga falla; el operador verá los warning logs y R4 quedará false en todas
 * las barras (conservador).
 */
async function _buildBtcAlignmentMap(klines, interval, utAtr, utKey) {
  const N = klines.length;
  if (N === 0) return new Map();

  const lastTime = klines[N - 1].openTime;
  // Fetch un poco más de barras para garantizar warmup de UT Bot
  // (atrPeriod + crossover lag = ~12 barras).
  const btcLimit = N + 50;

  let btcKlines;
  try {
    btcKlines = await loadKlinesCached("BTCUSDT", interval, {
      limit: btcLimit,
      endTime: lastTime,
    });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(
      `Aviso: no se pudo cargar contexto BTC para R4 (${e.message}). ` +
        `R4 será false en todas las barras (conservador).`,
    );
    return new Map();
  }

  if (!Array.isArray(btcKlines) || btcKlines.length === 0) return new Map();

  const btcUt = utBot(btcKlines, { atrPeriod: utAtr, keyValue: utKey });
  // utBot retorna `pos` directamente — usar eso (no derivar de close vs trailing).
  const map = new Map();
  for (let i = 0; i < btcKlines.length; i++) {
    const p = btcUt.pos[i];
    // pos puede ser 0 cuando no hay señal todavía; lo guardamos igual.
    if (Number.isFinite(p)) {
      map.set(btcKlines[i].openTime, p);
    }
  }
  return map;
}

// ---------------------------------------------------------------------------
// Estrategia
// ---------------------------------------------------------------------------

export const confluenceEngine = {
  name: "confluenceEngine",

  /**
   * Precomputa todos los lookups que `onBar` necesita en O(1):
   *   - signalAt[i]            (UT Bot Buy/Sell del par)
   *   - trailingStops[i]       (UT Bot trailing del par)
   *   - activeHighPivot[i] / activeLowPivot[i]  (LuxAlgo niveles activos)
   *   - visibleBreaks          (LuxAlgo B/S/wicks visibles)
   *   - volSMA20[i]            (vol simple 20)
   *   - btcAlignmentMap        (Map<openTime, btcPos>) — vacío para BTCUSDT
   *   - tier, sizeUSDT, leverage (resueltos via _tiers.js, con override CLI)
   *
   * @param {Array<{openTime:number,open:number,high:number,low:number,close:number,volume:number}>} klines
   * @param {{
   *   symbol:string, interval?:string,
   *   utAtr?:number, utKey?:number, breakWindow?:number,
   *   side?:'both'|'long'|'short',
   *   initialCapital?:number,
   *   positionSizeUSDT?:number, leverage?:number,
   *   [k:string]:any
   * }} options
   */
  async init(klines, options = {}) {
    if (!Array.isArray(klines) || klines.length === 0) {
      throw new Error("confluenceEngine.init: klines vacíos");
    }
    const symbol = options.symbol;
    if (!symbol) {
      throw new Error(
        "confluenceEngine.init: options.symbol es obligatorio (necesario para tier resolver y BTC alignment).",
      );
    }
    const interval = options.interval ?? "1h";
    const utAtr = options.utAtr ?? 10;
    const utKey = options.utKey ?? 2;
    const breakWindow = Number.isFinite(options.breakWindow)
      ? Math.trunc(options.breakWindow)
      : 3;
    if (breakWindow <= 0) {
      throw new Error(
        `confluenceEngine.init: breakWindow debe ser entero positivo (recibido: ${options.breakWindow}).`,
      );
    }
    const sideFilter = options.side ?? "both";
    if (!["both", "long", "short"].includes(sideFilter)) {
      throw new Error(
        `confluenceEngine.init: side inválido (${sideFilter}). Debe ser both | long | short.`,
      );
    }
    const initialCapital = Number.isFinite(options.initialCapital)
      ? options.initialCapital
      : 144;

    // 1) UT Bot sobre el símbolo objetivo
    const ut = utBot(klines, { atrPeriod: utAtr, keyValue: utKey });
    const trailingStops = ut.trailingStop; // alias semántico canónico
    const signalAt = new Array(klines.length).fill(null);
    for (const sig of ut.signals) signalAt[sig.index] = sig.type;

    // 2) LuxAlgo S&R sobre el símbolo objetivo
    const luxOpts = {
      leftBars: 15,
      rightBars: 15,
      volMaShort: 5,
      volMaLong: 10,
      volThresholdPct: 20,
    };
    const lux = luxAlgoSnR(klines, luxOpts);

    // 3) Reconstrucción per-bar de niveles activos via pivotHistory + shift.
    const N = klines.length;
    const { activeHigh, activeLow } = _buildActivePivots(
      N,
      lux.pivotHistory,
      luxOpts.rightBars,
    );

    // 4) Volume SMA(20) — fallback de R3 cuando R2 es falso.
    const volSMA20 = _volSma(
      klines.map((k) => k.volume),
      20,
    );

    // 5) BTC alignment (skip si el símbolo es BTCUSDT).
    let btcAlignmentMap = new Map();
    if (symbol !== "BTCUSDT") {
      btcAlignmentMap = await _buildBtcAlignmentMap(
        klines,
        interval,
        utAtr,
        utKey,
      );
    }

    // 6) Tier (con override CLI: --position-size y --leverage).
    const tierBase = resolveTier(symbol);
    const sizeUSDT = Number.isFinite(options.positionSizeUSDT)
      ? options.positionSizeUSDT
      : tierBase.sizeUSDT;
    const leverage = Number.isFinite(options.leverage)
      ? options.leverage
      : tierBase.leverage;

    return {
      // identidad / parámetros resueltos
      symbol,
      interval,
      sideFilter,
      breakWindow,
      initialCapital,
      // indicadores precomputados
      signalAt,
      trailingStops,
      trailingStop: trailingStops, // alias para compat con utBotOnly
      luxAlgo: lux,
      visibleBreaks: lux.visibleBreaks,
      activeHighPivot: activeHigh,
      activeLowPivot: activeLow,
      volSMA20,
      btcAlignmentMap,
      // sizing
      tier: tierBase.tier,
      sizeUSDT,
      leverage,
    };
  },

  /**
   * Decide acción en la barra actual.
   *
   * @param {{openTime:number,open:number,high:number,low:number,close:number,volume:number}} bar
   * @param {{
   *   i:number, klines:Array, position:object|null,
   *   state:object, options?:object
   * }} ctx
   */
  onBar(bar, ctx) {
    const state = ctx.state;
    const i = ctx.i;
    const position = ctx.position;
    const sig = state.signalAt[i];

    // (A) Si hay posición abierta, sólo cerramos por señal opuesta UT Bot.
    if (position) {
      if (sig === "Sell" && position.side === "long") {
        return { action: "close" };
      }
      if (sig === "Buy" && position.side === "short") {
        return { action: "close" };
      }
      return { action: "none" };
    }

    // (B) Sin posición y sin señal en esta barra → no hacemos nada.
    if (!sig) return { action: "none" };

    // (C) Lado candidato derivado del signal.
    const candidateSide = sig === "Buy" ? "long" : "short";
    const sideFilter = state.sideFilter;
    if (sideFilter === "long" && candidateSide !== "long") {
      return { action: "none" };
    }
    if (sideFilter === "short" && candidateSide !== "short") {
      return { action: "none" };
    }

    // ---- Confluencias ----

    // R1: signal en barra actual matchea el lado (siempre true acá; lo dejamos
    // explícito para registrar en el trade record).
    const r1 = true;

    // R2: visible LuxAlgo break (B/S, NO wicks) dentro de [i - breakWindow + 1, i]
    // en la dirección del trade.
    const wantBreakType = candidateSide === "long" ? "B" : "S";
    const lo = Math.max(0, i - state.breakWindow + 1);
    let qualifyingBreak = null;
    // Recorremos `visibleBreaks` linealmente; en producción podría memoizarse
    // con un índice por bar, pero para 6 meses 1h es trivialmente rápido.
    for (const br of state.visibleBreaks) {
      if (br.index < lo) continue;
      if (br.index > i) break; // visibleBreaks viene ordenado por index
      if (br.type === wantBreakType) {
        qualifyingBreak = br; // último break en ventana del tipo correcto
      }
    }
    const r2 = qualifyingBreak !== null;

    // R3: cuando R2 true → consume withVolume del break.
    //     cuando R2 false → fallback bar.volume > 1.2 × volSMA20.
    let r3;
    if (r2 && qualifyingBreak) {
      r3 = qualifyingBreak.withVolume === true;
    } else {
      const sma = state.volSMA20[i];
      r3 = Number.isFinite(sma) && bar.volume > 1.2 * sma;
    }

    // R4: contexto BTC alineado (auto-true si symbol === 'BTCUSDT').
    let r4;
    if (state.symbol === "BTCUSDT") {
      r4 = true;
    } else {
      const btcPos = state.btcAlignmentMap.get(bar.openTime);
      const want = candidateSide === "long" ? 1 : -1;
      r4 = btcPos === want;
    }

    const confluenceCount =
      (r1 ? 1 : 0) + (r2 ? 1 : 0) + (r3 ? 1 : 0) + (r4 ? 1 : 0);
    if (confluenceCount < 3) return { action: "none" };

    // ---- Stop híbrido ----
    const ts = state.trailingStops[i];
    if (!Number.isFinite(ts)) return { action: "none" };

    let stopPrice;
    if (candidateSide === "long") {
      const supp = state.activeLowPivot[i]?.price;
      stopPrice = Number.isFinite(supp) ? Math.max(ts, supp) : ts;
    } else {
      const res = state.activeHighPivot[i]?.price;
      stopPrice = Number.isFinite(res) ? Math.min(ts, res) : ts;
    }

    // Sanity: stop debe estar del lado correcto del precio actual.
    const entryClose = bar.close;
    if (candidateSide === "long" && stopPrice >= entryClose) {
      return { action: "none" };
    }
    if (candidateSide === "short" && stopPrice <= entryClose) {
      return { action: "none" };
    }

    // ---- TP @ 2.5R ----
    const R = Math.abs(entryClose - stopPrice);
    if (!Number.isFinite(R) || R === 0) return { action: "none" };
    const sideMul = candidateSide === "long" ? 1 : -1;
    const tpPrice = entryClose + 2.5 * R * sideMul;

    // ---- Sizing (override CLI ya aplicado en init) ----
    const sizeUSDT = state.sizeUSDT;
    const leverage = state.leverage;

    // ---- Max-loss gate ----
    const impliedLoss = (sizeUSDT * leverage * R) / entryClose;
    const maxLoss = 0.03 * state.initialCapital;
    if (impliedLoss > maxLoss) return { action: "none" };

    return {
      action: "open",
      side: candidateSide,
      stopPrice,
      tpPrice,
      sizeUSDT,
      leverage,
      confluence: { r1, r2, r3, r4 },
      confluenceCount,
      tier: state.tier,
    };
  },
};

export default confluenceEngine;
