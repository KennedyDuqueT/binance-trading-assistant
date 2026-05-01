// CLI: señales locales de UT Bot Alerts + LuxAlgo S&R with Breaks
// sobre velas de Binance Futures.
//
// Uso:
//   node scripts/signals.js BTCUSDT 1h
//   node scripts/signals.js ETHUSDT 4h --json
//   node scripts/signals.js SOLUSDT 1h --ut-key 3 --lux-pivot 10 --lux-vol-pct 25
//
// Flags:
//   --json              Emite JSON estructurado en stdout.
//   --ut-atr <N>        Período del ATR (default 10).
//   --ut-key <N>        Multiplicador del ATR para el trailing stop (default 2).
//   --lux-pivot <N>     leftBars = rightBars = N (default 15).
//   --lux-vol-pct <N>   Umbral del oscilador SMA de volumen, en % (default 20).
//   --limit <N>         Cantidad de velas a pedir (default 300).
//
// Códigos de salida:
//   0 = OK (también en velas insuficientes; emite secciones vacías).
//   1 = uso inválido (faltan SYMBOL o INTERVAL).
//   2 = error de red/HTTP al consultar Binance.

import { fetchKlines } from "./lib/klines.js";
import { utBot, luxAlgoSnR } from "./lib/indicators.js";

// ---------------------------------------------------------------------------
// argv parsing
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
const positional = argv.filter((a) => !a.startsWith("--"));

function flag(name) {
  const idx = argv.indexOf(`--${name}`);
  if (idx === -1) return undefined;
  const next = argv[idx + 1];
  if (next === undefined || next.startsWith("--")) return true;
  return next;
}

function flagNum(name, fallback) {
  const v = flag(name);
  if (v === undefined || v === true) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

const symbolRaw = positional[0];
const intervalRaw = positional[1];

if (!symbolRaw || !intervalRaw) {
  console.error(
    "Uso: node scripts/signals.js SÍMBOLO INTERVALO [--json --ut-atr N --ut-key N --lux-pivot N --lux-vol-pct N --limit N]"
  );
  console.error("Ejemplo: node scripts/signals.js BTCUSDT 1h --json --ut-key 3");
  process.exit(1);
}

const symbol = String(symbolRaw).toUpperCase();
const interval = String(intervalRaw);

const wantJson = flag("json") === true;
const atrPeriod = flagNum("ut-atr", 10);
const keyValue = flagNum("ut-key", 2);
const luxPivot = flagNum("lux-pivot", 15);
const volThresholdPct = flagNum("lux-vol-pct", 20);
const limit = flagNum("limit", 300);

// ---------------------------------------------------------------------------
// Helpers de formato (Spanish)
// ---------------------------------------------------------------------------

function fmtPrice(n) {
  if (!Number.isFinite(n)) return "n/d";
  if (Math.abs(n) >= 1000) return n.toFixed(2);
  if (Math.abs(n) >= 1) return n.toFixed(4);
  return n.toFixed(6);
}

function fmtRelative(barsAgo, interval) {
  // Convertimos "barras" a una expresión relativa simple, asumiendo que el
  // operador conoce el timeframe. Devolvemos "hace N velas".
  if (barsAgo <= 0) return "ahora";
  if (barsAgo === 1) return "hace 1 vela";
  return `hace ${barsAgo} velas`;
}

function fmtIsoMs(ts) {
  if (!Number.isFinite(ts)) return "n/d";
  return new Date(ts).toISOString();
}

function fmtPos(p) {
  if (p > 0) return "long";
  if (p < 0) return "short";
  return "flat";
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

let klines;
try {
  klines = await fetchKlines(symbol, interval, { limit });
} catch (err) {
  const msg = err && err.message ? err.message : String(err);
  console.error(`Error: fallo al consultar Binance Futures: ${msg}`);
  process.exit(2);
}

if (!Array.isArray(klines) || klines.length === 0) {
  console.error(`Aviso: no se recibieron velas para ${symbol} ${interval}.`);
  if (wantJson) {
    process.stdout.write(
      JSON.stringify(
        {
          params: {
            atrPeriod,
            keyValue,
            leftBars: luxPivot,
            rightBars: luxPivot,
            volMaShort: 5,
            volMaLong: 10,
            volThresholdPct,
            limit,
          },
          klinesMeta: {
            symbol,
            interval,
            count: 0,
            firstOpenTime: null,
            lastOpenTime: null,
          },
          utBot: { signals: [], lastSignal: null, trailingStop: [], pos: [] },
          luxAlgo: {
            highUsePivot: null,
            lowUsePivot: null,
            breaks: [],
            visibleBreaks: [],
            lastBreak: null,
            lastVisibleBreak: null,
            pivotHistory: { highs: [], lows: [] },
          },
        },
        null,
        2
      ) + "\n"
    );
  } else {
    console.log(`# Señales locales — ${symbol} ${interval}\n`);
    console.log("## UT Bot");
    console.log("- Sin datos suficientes.\n");
    console.log("## LuxAlgo S&R");
    console.log("- Sin datos suficientes.\n");
    console.log("## Validación cruzada");
    console.log(
      "Compará con TradingView. Si las labels Buy/Sell o B/S no aparecen en el mismo candle, ajustá los parámetros con --ut-atr, --ut-key, --lux-pivot, --lux-vol-pct."
    );
  }
  process.exit(0);
}

// Cómputo (síncrono, puro).
let utResult;
let luxResult;
try {
  utResult = utBot(klines, { atrPeriod, keyValue });
  luxResult = luxAlgoSnR(klines, {
    leftBars: luxPivot,
    rightBars: luxPivot,
    volMaShort: 5,
    volMaLong: 10,
    volThresholdPct,
  });
} catch (err) {
  const msg = err && err.message ? err.message : String(err);
  console.error(`Error: cálculo de indicadores falló: ${msg}`);
  process.exit(2);
}

const lastIdx = klines.length - 1;
const lastClose = klines[lastIdx].close;
const lastTime = klines[lastIdx].openTime;
const trailing = utResult.trailingStop[lastIdx];
const lastPos = utResult.pos[lastIdx];

if (wantJson) {
  const payload = {
    params: {
      atrPeriod,
      keyValue,
      leftBars: luxPivot,
      rightBars: luxPivot,
      volMaShort: 5,
      volMaLong: 10,
      volThresholdPct,
      limit,
    },
    klinesMeta: {
      symbol,
      interval,
      count: klines.length,
      firstOpenTime: klines[0].openTime,
      lastOpenTime: lastTime,
    },
    utBot: {
      signals: utResult.signals,
      lastSignal: utResult.lastSignal,
      trailingStop: Number.isFinite(trailing) ? trailing : null,
      pos: lastPos,
    },
    luxAlgo: {
      highUsePivot: luxResult.highUsePivot,
      lowUsePivot: luxResult.lowUsePivot,
      breaks: luxResult.breaks,
      visibleBreaks: luxResult.visibleBreaks,
      lastBreak: luxResult.lastBreak,
      lastVisibleBreak: luxResult.lastVisibleBreak,
      pivotHistory: luxResult.pivotHistory,
    },
  };
  process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
  process.exit(0);
}

// Reporte humano (Spanish).
const buys = utResult.signals.filter((s) => s.type === "Buy");
const sells = utResult.signals.filter((s) => s.type === "Sell");
const lastBuy = buys.length ? buys[buys.length - 1] : null;
const lastSell = sells.length ? sells[sells.length - 1] : null;

const reportLines = [];
reportLines.push(
  `# Señales locales — ${symbol} ${interval} — ${fmtIsoMs(lastTime)}`
);
reportLines.push(`Precio: ${fmtPrice(lastClose)}`);
reportLines.push("");

reportLines.push(`## UT Bot (ATR=${atrPeriod}, key=${keyValue})`);
if (lastBuy) {
  const ago = lastIdx - lastBuy.index;
  reportLines.push(
    `- Último Buy: ${fmtRelative(ago, interval)} a ${fmtPrice(lastBuy.price)}`
  );
} else {
  reportLines.push("- Último Buy: n/d");
}
if (lastSell) {
  const ago = lastIdx - lastSell.index;
  reportLines.push(
    `- Último Sell: ${fmtRelative(ago, interval)} a ${fmtPrice(lastSell.price)}`
  );
} else {
  reportLines.push("- Último Sell: n/d");
}
reportLines.push(
  `- Estado actual: ${fmtPos(lastPos)} con trailing stop en ${fmtPrice(trailing)}`
);
reportLines.push("");

reportLines.push(
  `## LuxAlgo S&R (pivot=${luxPivot}, vol filter=${volThresholdPct}%)`
);
if (luxResult.highUsePivot) {
  const hp = luxResult.highUsePivot;
  const ago = lastIdx - hp.pivotIndex;
  reportLines.push(
    `- Resistencia activa: ${fmtPrice(hp.price)} (confirmada ${fmtRelative(ago, interval)})`
  );
} else {
  reportLines.push("- Resistencia activa: n/d");
}
if (luxResult.lowUsePivot) {
  const lp = luxResult.lowUsePivot;
  const ago = lastIdx - lp.pivotIndex;
  reportLines.push(
    `- Soporte activo: ${fmtPrice(lp.price)} (confirmado ${fmtRelative(ago, interval)})`
  );
} else {
  reportLines.push("- Soporte activo: n/d");
}
if (luxResult.lastVisibleBreak) {
  const lb = luxResult.lastVisibleBreak;
  const ago = lastIdx - lb.index;
  const labelMap = {
    B: "B (body)",
    S: "S (body)",
    Bull_Wick: "Bull Wick",
    Bear_Wick: "Bear Wick",
  };
  const label = labelMap[lb.type] || lb.type;
  const dirText = lb.direction === "up" ? "rompió resistencia" : "rompió soporte";
  const volText =
    lb.shape === "wick"
      ? lb.withVolume
        ? "con volumen alto (rechazo confirmado)"
        : "sin filtro de volumen (wick)"
      : "con volumen confirmado";
  reportLines.push(
    `- Último break visible: ${label} ${fmtRelative(ago, interval)} a ${fmtPrice(lb.closePrice)}`
  );
  reportLines.push(
    `  ${dirText} en ${fmtPrice(lb.levelBroken)} ${volText}`
  );
} else {
  reportLines.push("- Último break visible: n/d");
}
reportLines.push(
  "- Tipos de break: B/S = body con volumen | Bull Wick / Bear Wick = wick (rechazo)"
);
reportLines.push("");

reportLines.push("## Validación cruzada");
reportLines.push(
  "Compará con TradingView. Si las labels Buy/Sell o B/S no aparecen en el mismo"
);
reportLines.push(
  "candle, ajustá los parámetros con --ut-key (default 2), --lux-pivot (default 15),"
);
reportLines.push("--lux-vol-pct (default 20), --ut-atr (default 10).");

process.stdout.write(reportLines.join("\n") + "\n");
process.exit(0);
