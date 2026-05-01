// Indicadores técnicos puros sobre arrays de klines de Binance Futures.
// Implementación hand-rolled para igualar la semántica de TradingView Pine Script:
//   - ATR con suavizado de Wilder (semilla SMA), igual que ta.atr.
//   - EMA(period=1) === source (UT Bot usa este atajo).
//   - Pivots con confirmación rezagada por rightBars (igual que ta.pivothigh/low).
//   - UT Bot trailing stop con cuatro ramas (QuantNomad/UT Bot Alerts).
//   - LuxAlgo S&R with Breaks: pivots → niveles activos → break por close + filtro
//     de volumen via SMA oscillator.
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
// LuxAlgo Support & Resistance with Breaks (decisiones D4, D5)
// ---------------------------------------------------------------------------

/**
 * LuxAlgo S&R with Breaks. Emite niveles activos (top-keepLast por lado),
 * y arreglo de breaks confirmados por close. withVolume es informativo:
 * el break se emite siempre, el flag indica si el oscilador SMA pasó el umbral.
 *
 * @param {Array<{openTime:number,high:number,low:number,close:number,volume:number}>} klines
 * @param {{
 *   leftBars?:number, rightBars?:number,
 *   volMaShort?:number, volMaLong?:number, volThresholdPct?:number,
 *   keepLast?:number
 * }} [opts]
 * @returns {{
 *   supports: Array<{index:number,time:number,price:number,broken:boolean}>,
 *   resistances: Array<{index:number,time:number,price:number,broken:boolean}>,
 *   breaks: Array<{index:number,time:number,type:'B'|'S',price:number,withVolume:boolean}>,
 *   lastBreak: object|null
 * }}
 */
export function luxAlgoSnR(klines, opts = {}) {
  if (!Array.isArray(klines) || klines.length === 0) {
    throw new Error("klines vacíos");
  }
  const {
    leftBars = 15,
    rightBars = 15,
    volMaShort = 5,
    volMaLong = 10,
    volThresholdPct = 20,
    keepLast = 5,
  } = opts;
  const n = klines.length;

  const empty = {
    supports: [],
    resistances: [],
    breaks: [],
    lastBreak: null,
  };

  if (n < leftBars + rightBars + volMaLong) return empty;

  // Volumen para el oscilador SMA.
  const volumes = klines.map((k) => k.volume);
  const volS = sma(volumes, volMaShort);
  const volL = sma(volumes, volMaLong);

  // Listas activas (no-broken) y archivo total.
  const activeResistances = [];
  const activeSupports = [];
  const allResistances = [];
  const allSupports = [];
  const breaks = [];

  // Iteramos i desde la primera barra que puede confirmar un pivot
  // (i.e., el pivot está en i - rightBars y necesita leftBars a la izquierda).
  for (let i = leftBars + rightBars; i < n; i++) {
    const pivotIdx = i - rightBars;

    // Strict max/min en [pivotIdx-leftBars, pivotIdx+rightBars] excluyendo pivotIdx.
    const ph = klines[pivotIdx].high;
    const pl = klines[pivotIdx].low;
    let isHigh = true;
    let isLow = true;
    for (let j = pivotIdx - leftBars; j <= pivotIdx + rightBars; j++) {
      if (j === pivotIdx) continue;
      if (klines[j].high >= ph) isHigh = false;
      if (klines[j].low <= pl) isLow = false;
      if (!isHigh && !isLow) break;
    }

    if (isHigh) {
      const lvl = {
        index: pivotIdx,
        time: klines[pivotIdx].openTime,
        price: ph,
        broken: false,
      };
      activeResistances.push(lvl);
      allResistances.push(lvl);
      // Mantener solo los últimos keepLast activos.
      while (activeResistances.length > keepLast) activeResistances.shift();
    }
    if (isLow) {
      const lvl = {
        index: pivotIdx,
        time: klines[pivotIdx].openTime,
        price: pl,
        broken: false,
      };
      activeSupports.push(lvl);
      allSupports.push(lvl);
      while (activeSupports.length > keepLast) activeSupports.shift();
    }

    // Filtro de volumen (decisión D5).
    let withVolume = false;
    const vS = volS[i];
    const vL = volL[i];
    if (Number.isFinite(vS) && Number.isFinite(vL) && vL > 0) {
      const osc = ((vS - vL) / vL) * 100;
      withVolume = osc > volThresholdPct;
    }

    const c = klines[i].close;

    // Detectar break en resistencias activas.
    for (let r = activeResistances.length - 1; r >= 0; r--) {
      const lvl = activeResistances[r];
      if (!lvl.broken && c > lvl.price) {
        lvl.broken = true;
        breaks.push({
          index: i,
          time: klines[i].openTime,
          type: "B",
          price: lvl.price,
          withVolume,
        });
        activeResistances.splice(r, 1);
      }
    }
    // Detectar break en soportes activos.
    for (let s = activeSupports.length - 1; s >= 0; s--) {
      const lvl = activeSupports[s];
      if (!lvl.broken && c < lvl.price) {
        lvl.broken = true;
        breaks.push({
          index: i,
          time: klines[i].openTime,
          type: "S",
          price: lvl.price,
          withVolume,
        });
        activeSupports.splice(s, 1);
      }
    }
  }

  return {
    supports: activeSupports.slice(),
    resistances: activeResistances.slice(),
    breaks,
    lastBreak: breaks.length ? breaks[breaks.length - 1] : null,
  };
}
