// Indicadores técnicos puros sobre arrays de klines de Binance Futures.
// Implementación hand-rolled para igualar la semántica de TradingView Pine Script:
//   - ATR con suavizado de Wilder (semilla SMA), igual que ta.atr.
//   - EMA(period=1) === source (UT Bot usa este atajo).
//   - Pivots con confirmación rezagada por rightBars (igual que ta.pivothigh/low).
//   - UT Bot trailing stop con cuatro ramas (QuantNomad/UT Bot Alerts).
//   - LuxAlgo S&R with Breaks: port línea-a-línea del Pine v4 oficial.
//     Mantiene UN SOLO nivel activo por lado (highUsePivot/lowUsePivot via
//     fixnan(pivothigh(...)[1])), separa B/S (body+volumen) de Bull/Bear Wick
//     (rechazo, sin gate de volumen), y usa EMA(volume, 5/10) para el oscilador.
//
// ESM puro. Sin imports más allá de intrínsecos. Sin I/O ni mutación global.
//
// Exporta: utBot, luxAlgoSnR, atr, ema, sma, pivots.

// ---------------------------------------------------------------------------
// Helpers básicos
// ---------------------------------------------------------------------------

/**
 * Simple moving average sobre values en la ventana [i-period+1..i].
 * Devuelve un array del mismo largo, con NaN antes del seed.
 */
export function sma(values, period) {
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
 * EMA estándar con semilla SMA. Para period === 1, devuelve copia de values.
 *
 * Nota: TradingView ta.ema también usa SMA-seed al primer bar válido, así que
 * esta implementación es compatible con Pine. Antes del seed, las posiciones
 * son NaN (el consumidor de luxAlgoSnR ya filtra null/undefined/NaN al evaluar
 * el oscilador de volumen, dado que `NaN > threshold` es false).
 */
export function ema(values, period) {
  const n = values.length;
  if (period === 1) return values.slice();
  const out = new Array(n).fill(NaN);
  if (period <= 0 || n < period) return out;

  let seedSum = 0;
  for (let i = 0; i < period; i++) seedSum += values[i];
  out[period - 1] = seedSum / period;

  const k = 2 / (period + 1);
  for (let i = period; i < n; i++) {
    out[i] = values[i] * k + out[i - 1] * (1 - k);
  }
  return out;
}

/**
 * ATR con suavizado de Wilder (decisión D3).
 * TR[i] = max(high-low, abs(high-prev_close), abs(low-prev_close)).
 * Semilla en i=period-1 = mean(TR[0..period-1]).
 * i >= period: ATR[i] = (ATR[i-1]*(period-1) + TR[i]) / period.
 *
 * @param {Array<{high:number,low:number,close:number}>} klines
 * @param {number} period
 * @returns {number[]} mismo length que klines, NaN antes de la semilla
 */
export function atr(klines, period) {
  const n = klines.length;
  const out = new Array(n).fill(NaN);
  if (period <= 0 || n < period) return out;

  const tr = new Array(n).fill(NaN);
  tr[0] = klines[0].high - klines[0].low;
  for (let i = 1; i < n; i++) {
    const h = klines[i].high;
    const l = klines[i].low;
    const pc = klines[i - 1].close;
    tr[i] = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
  }

  // Semilla SMA sobre TR[0..period-1].
  let seedSum = 0;
  for (let i = 0; i < period; i++) seedSum += tr[i];
  out[period - 1] = seedSum / period;

  // Wilder.
  for (let i = period; i < n; i++) {
    out[i] = (out[i - 1] * (period - 1) + tr[i]) / period;
  }
  return out;
}

/**
 * Pivots con confirmación rezagada por rightBars (decisión D4).
 * Pivot high en index i: high[i] estricto-mayor que todos los high en
 * [i-leftBars, i+rightBars] excluyendo i. Pivot low simétrico con strict-min.
 *
 * @param {Array<{high:number,low:number,openTime:number}>} klines
 * @param {number} leftBars
 * @param {number} rightBars
 * @returns {{ highs: Array<{index:number,time:number,price:number}>,
 *             lows:  Array<{index:number,time:number,price:number}> }}
 */
export function pivots(klines, leftBars, rightBars) {
  const n = klines.length;
  const highs = [];
  const lows = [];

  for (let i = leftBars; i < n - rightBars; i++) {
    const h = klines[i].high;
    const l = klines[i].low;
    let isHigh = true;
    let isLow = true;

    for (let j = i - leftBars; j <= i + rightBars; j++) {
      if (j === i) continue;
      if (klines[j].high >= h) isHigh = false;
      if (klines[j].low <= l) isLow = false;
      if (!isHigh && !isLow) break;
    }

    if (isHigh) highs.push({ index: i, time: klines[i].openTime, price: h });
    if (isLow) lows.push({ index: i, time: klines[i].openTime, price: l });
  }

  return { highs, lows };
}

// ---------------------------------------------------------------------------
// UT Bot Alerts (decisión D2)
// ---------------------------------------------------------------------------

/**
 * UT Bot. Implementa el trailing stop de cuatro ramas y emite Buy/Sell por
 * crossover/crossunder de close vs trailing stop (ema(close,1) === close).
 *
 * @param {Array<{openTime:number,high:number,low:number,close:number}>} klines
 * @param {{atrPeriod?:number,keyValue?:number,useHA?:boolean}} [opts]
 * @returns {{
 *   signals: Array<{index:number,time:number,type:'Buy'|'Sell',price:number}>,
 *   lastSignal: {index:number,time:number,type:'Buy'|'Sell',price:number}|null,
 *   trailingStop: number[],
 *   pos: number[]
 * }}
 */
export function utBot(klines, opts = {}) {
  if (!Array.isArray(klines) || klines.length === 0) {
    throw new Error("klines vacíos");
  }
  const { atrPeriod = 10, keyValue = 1 } = opts;
  const n = klines.length;

  const empty = {
    signals: [],
    lastSignal: null,
    trailingStop: new Array(n).fill(NaN),
    pos: new Array(n).fill(0),
  };

  // Necesitamos al menos atrPeriod+2 barras para tener un trailing válido y un crossover.
  if (n < atrPeriod + 2) return empty;

  const xATR = atr(klines, atrPeriod);
  const nLoss = xATR.map((v) => keyValue * v);

  const ts = new Array(n).fill(NaN);
  // Inicializamos el trailing stop a partir del primer índice con ATR válido.
  const firstValid = atrPeriod - 1;
  ts[firstValid] = klines[firstValid].close;

  for (let i = firstValid + 1; i < n; i++) {
    const src = klines[i].close;
    const prevSrc = klines[i - 1].close;
    const prev = ts[i - 1];
    const loss = nLoss[i];

    if (src > prev && prevSrc > prev) {
      ts[i] = Math.max(prev, src - loss);
    } else if (src < prev && prevSrc < prev) {
      ts[i] = Math.min(prev, src + loss);
    } else if (src > prev) {
      ts[i] = src - loss;
    } else {
      ts[i] = src + loss;
    }
  }

  // Posición long/short/flat por barra.
  const pos = new Array(n).fill(0);
  for (let i = firstValid + 2; i < n; i++) {
    const c = klines[i].close;
    const cPrev = klines[i - 1].close;
    const tsPrev = ts[i - 1];
    if (cPrev < tsPrev && c > tsPrev) pos[i] = 1;
    else if (cPrev > tsPrev && c < tsPrev) pos[i] = -1;
    else pos[i] = pos[i - 1];
  }

  // Señales: Buy = close > ts && crossover(close, ts).
  const signals = [];
  for (let i = firstValid + 2; i < n; i++) {
    const c = klines[i].close;
    const cPrev = klines[i - 1].close;
    const t = ts[i];
    const tPrev = ts[i - 1];

    const crossUp = cPrev <= tPrev && c > t;
    const crossDown = cPrev >= tPrev && c < t;

    if (c > t && crossUp) {
      signals.push({ index: i, time: klines[i].openTime, type: "Buy", price: c });
    } else if (c < t && crossDown) {
      signals.push({ index: i, time: klines[i].openTime, type: "Sell", price: c });
    }
  }

  return {
    signals,
    lastSignal: signals.length ? signals[signals.length - 1] : null,
    trailingStop: ts,
    pos,
  };
}

// ---------------------------------------------------------------------------
// LuxAlgo Support & Resistance with Breaks
// ---------------------------------------------------------------------------

/**
 * LuxAlgo "Support and Resistance Levels with Breaks" — port línea-a-línea
 * del Pine Script v4 oficial.
 *
 * Pine source (resumen):
 *   highUsePivot = fixnan(pivothigh(leftBars, rightBars)[1])
 *   lowUsePivot  = fixnan(pivotlow(leftBars,  rightBars)[1])
 *   short = ema(volume, 5);  long = ema(volume, 10)
 *   osc   = 100 * (short - long) / long
 *   "B"        : crossover(close,  highUsePivot) AND not(open - low > close - open) AND osc > volThresh
 *   "S"        : crossunder(close, lowUsePivot)  AND not(open - close < high - open) AND osc > volThresh
 *   "Bull Wick": crossover(close,  highUsePivot) AND (open - low > close - open)
 *   "Bear Wick": crossunder(close, lowUsePivot)  AND (open - close < high - open)
 *
 * Diferencias respecto al puerto anterior (las 5 que confirmó el operador):
 *   1) UN SOLO nivel activo por lado (no una lista de últimos N).
 *   2) Cuatro categorías de break (B, S, Bull_Wick, Bear_Wick), no solo B/S.
 *   3) Oscilador con EMA(volume, 5/10), NO SMA.
 *   4) B/S sólo si osc > umbral (sino se loguea como B_unconfirmed/S_unconfirmed
 *      en `breaks` para inspección, fuera de `visibleBreaks`).
 *   5) `pivothigh(...)[1]` agrega 1 barra de retraso adicional sobre rightBars:
 *      el pivot detectado en `src` recién está activo en bar `src + rightBars + 1`.
 *
 * @param {Array<{openTime:number,open:number,high:number,low:number,close:number,volume:number}>} klines
 * @param {{
 *   leftBars?:number, rightBars?:number,
 *   volMaShort?:number, volMaLong?:number, volThresholdPct?:number
 * }} [opts]
 * @returns {{
 *   highUsePivot: {price:number,pivotIndex:number,time:number}|null,
 *   lowUsePivot:  {price:number,pivotIndex:number,time:number}|null,
 *   breaks: Array<object>,
 *   visibleBreaks: Array<object>,
 *   lastBreak: object|null,
 *   lastVisibleBreak: object|null,
 *   pivotHistory: { highs: Array<object>, lows: Array<object> }
 * }}
 */
export function luxAlgoSnR(klines, opts = {}) {
  const {
    leftBars = 15,
    rightBars = 15,
    volMaShort = 5,
    volMaLong = 10,
    volThresholdPct = 20,
  } = opts;

  const N = klines.length;
  if (N === 0) throw new Error("klines vacíos");

  // Sin barras suficientes para detectar siquiera un pivot con el shift [1].
  if (N < leftBars + rightBars + 2) {
    return {
      highUsePivot: null,
      lowUsePivot: null,
      breaks: [],
      visibleBreaks: [],
      lastBreak: null,
      lastVisibleBreak: null,
      pivotHistory: { highs: [], lows: [] },
    };
  }

  const close = klines.map((k) => k.close);
  const open = klines.map((k) => k.open);
  const high = klines.map((k) => k.high);
  const low = klines.map((k) => k.low);
  const vol = klines.map((k) => k.volume);
  const time = klines.map((k) => k.openTime);

  // ---- Oscilador de volumen: EMA-based (NO SMA). ----
  const emaShort = ema(vol, volMaShort);
  const emaLong = ema(vol, volMaLong);
  const osc = new Array(N);
  for (let i = 0; i < N; i++) {
    const L = emaLong[i];
    osc[i] =
      L !== null && L !== undefined && L > 0
        ? (100 * (emaShort[i] - L)) / L
        : null;
  }

  // ---- Pivot detection (estricto a ambos lados, igual que ta.pivothigh/low). ----
  const isPivotHigh = new Array(N).fill(false);
  const isPivotLow = new Array(N).fill(false);
  for (let i = leftBars; i <= N - 1 - rightBars; i++) {
    let pHigh = true,
      pLow = true;
    const h = high[i],
      l = low[i];
    for (let j = i - leftBars; j < i; j++) {
      if (pHigh && high[j] >= h) pHigh = false;
      if (pLow && low[j] <= l) pLow = false;
      if (!pHigh && !pLow) break;
    }
    if (pHigh || pLow) {
      for (let j = i + 1; j <= i + rightBars; j++) {
        if (pHigh && high[j] >= h) pHigh = false;
        if (pLow && low[j] <= l) pLow = false;
        if (!pHigh && !pLow) break;
      }
    }
    isPivotHigh[i] = pHigh;
    isPivotLow[i] = pLow;
  }

  // ---- highUsePivot[j] / lowUsePivot[j] = fixnan(pivothigh(...)[1]).
  // En la barra j, el pivot fuente es j-1-rightBars; si es pivot, actualiza,
  // sino se carry-forward el último conocido. Esto reproduce el shift `[1]`.
  const highUsePivot = new Array(N).fill(null);
  const lowUsePivot = new Array(N).fill(null);
  let lastH = null,
    lastL = null;
  for (let j = 0; j < N; j++) {
    const src = j - 1 - rightBars;
    if (src >= 0 && isPivotHigh[src]) lastH = { price: high[src], pivotIndex: src };
    if (src >= 0 && isPivotLow[src]) lastL = { price: low[src], pivotIndex: src };
    highUsePivot[j] = lastH;
    lowUsePivot[j] = lastL;
  }

  // ---- Detección de breaks/wicks. ----
  const breaks = [];
  for (let j = 1; j < N; j++) {
    const hPrev = highUsePivot[j - 1],
      hCurr = highUsePivot[j];
    const lPrev = lowUsePivot[j - 1],
      lCurr = lowUsePivot[j];

    // Bullish: crossover de close sobre highUsePivot.
    if (hPrev && hCurr && close[j - 1] <= hPrev.price && close[j] > hCurr.price) {
      const lowerWick = open[j] - low[j];
      const bodyUpMove = close[j] - open[j];
      const isBullWick = lowerWick > bodyUpMove;
      const volPasses = osc[j] !== null && osc[j] > volThresholdPct;

      if (isBullWick) {
        breaks.push({
          index: j,
          time: time[j],
          type: "Bull_Wick",
          closePrice: close[j],
          levelBroken: hCurr.price,
          direction: "up",
          shape: "wick",
          withVolume: volPasses,
          volumeOscillator: osc[j],
        });
      } else if (volPasses) {
        breaks.push({
          index: j,
          time: time[j],
          type: "B",
          closePrice: close[j],
          levelBroken: hCurr.price,
          direction: "up",
          shape: "body",
          withVolume: true,
          volumeOscillator: osc[j],
        });
      } else {
        breaks.push({
          index: j,
          time: time[j],
          type: "B_unconfirmed",
          closePrice: close[j],
          levelBroken: hCurr.price,
          direction: "up",
          shape: "body",
          withVolume: false,
          volumeOscillator: osc[j],
        });
      }
    }

    // Bearish: crossunder de close bajo lowUsePivot.
    if (lPrev && lCurr && close[j - 1] >= lPrev.price && close[j] < lCurr.price) {
      const upperWick = high[j] - open[j];
      const bodyDownMove = open[j] - close[j];
      // Pine: not(open - close < high - open) → bearWick si (open - close) < (high - open).
      const isBearWick = bodyDownMove < upperWick;
      const volPasses = osc[j] !== null && osc[j] > volThresholdPct;

      if (isBearWick) {
        breaks.push({
          index: j,
          time: time[j],
          type: "Bear_Wick",
          closePrice: close[j],
          levelBroken: lCurr.price,
          direction: "down",
          shape: "wick",
          withVolume: volPasses,
          volumeOscillator: osc[j],
        });
      } else if (volPasses) {
        breaks.push({
          index: j,
          time: time[j],
          type: "S",
          closePrice: close[j],
          levelBroken: lCurr.price,
          direction: "down",
          shape: "body",
          withVolume: true,
          volumeOscillator: osc[j],
        });
      } else {
        breaks.push({
          index: j,
          time: time[j],
          type: "S_unconfirmed",
          closePrice: close[j],
          levelBroken: lCurr.price,
          direction: "down",
          shape: "body",
          withVolume: false,
          volumeOscillator: osc[j],
        });
      }
    }
  }

  // Subset visible en TradingView (B, S, Bull_Wick, Bear_Wick).
  const VISIBLE = new Set(["B", "S", "Bull_Wick", "Bear_Wick"]);
  const visibleBreaks = breaks.filter((b) => VISIBLE.has(b.type));

  // Historial de pivots en la ventana — útil para inspección JSON.
  const pivotHistory = { highs: [], lows: [] };
  for (let i = 0; i < N; i++) {
    if (isPivotHigh[i])
      pivotHistory.highs.push({ index: i, time: time[i], price: high[i] });
    if (isPivotLow[i])
      pivotHistory.lows.push({ index: i, time: time[i], price: low[i] });
  }

  // Niveles activos finales (los que estarían visibles en chart en la última vela).
  const lastHigh = highUsePivot[N - 1];
  const lastLow = lowUsePivot[N - 1];

  return {
    highUsePivot: lastHigh
      ? {
          price: lastHigh.price,
          pivotIndex: lastHigh.pivotIndex,
          time: time[lastHigh.pivotIndex],
        }
      : null,
    lowUsePivot: lastLow
      ? {
          price: lastLow.price,
          pivotIndex: lastLow.pivotIndex,
          time: time[lastLow.pivotIndex],
        }
      : null,
    breaks,
    visibleBreaks,
    lastBreak: breaks.length ? breaks[breaks.length - 1] : null,
    lastVisibleBreak: visibleBreaks.length
      ? visibleBreaks[visibleBreaks.length - 1]
      : null,
    pivotHistory,
  };
}
