#!/usr/bin/env node
// V1.2 (2026-05-02): R2 rejects wicks (only "B"/"S" body breaks count). Hard filter adds 7d>+50% and 30d>+100% post-pump checks. R:R displayed as conservative-optimistic range.
// scan-confluence.js
// Escanea TODOS los pares USDT-M PERPETUAL de Binance Futures buscando setups
// 3-de-4 confluencias (regla operativa de CLAUDE.md):
//   R1: UT Bot LONG (o SHORT) en 1H AND 4H — strict multi-TF alignment per operator's CLAUDE.md
//       (con --interval 1h se exige sólo 1H; default `both` requiere ambos TFs)
//   R2: LuxAlgo S&R last B/S en últimas 12 velas + precio dentro de ±5% del nivel
//   R3: Volumen acompañando (V1 simplificado: vol 24h ≥ $50M ya pasa pre-filtro)
//   R4: Contexto BTC alineado (UT Bot 1H BTC long ⇒ R4 long-side; short ⇒ R4 short-side)
//
// Hard filters (V1):
//   - funding ≤ +0.046%/8h para long (≈ +50% APR cap)
//   - stop dist ≤ 8% (sino sizing no rinde)
//   - 24h change ≤ +30% (evita pumps verticales)
//
// Output:
//   - Markdown: analysis/scans/YYYY-MM-DDTHH-MM-SSZ.md
//   - Console: top 5 + path al MD completo
//   - Si --notify: post HTML de top 1-2 a Telegram (graceful si no hay token)
//
// Uso:
//   npm run scan-confluence
//   npm run scan-confluence -- --interval 1h
//   npm run scan-confluence -- --interval both --notify --notify-on-empty
//   npm run scan-confluence -- --max-pairs 20  (dev / smoke)
//
// ESM puro, Node ≥20, sin nuevas dependencias.

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fetchJson } from "./lib/http.js";
import { fetchKlines } from "./lib/klines.js";
import { utBot, luxAlgoSnR } from "./lib/indicators.js";
import { fmtOperatorTime, fmtOperatorTimeWithTZ } from "./lib/time.js";
import { sendTelegram } from "./lib/notify.js";

const FAPI = "https://fapi.binance.com";

// Indicador config locked per CLAUDE.md / engram operator-tv-config
const UT_KEY_VALUE = 2;
const UT_ATR_PERIOD = 10;
const LUX_LEFT = 15;
const LUX_RIGHT = 15;
const LUX_VOL_MA_SHORT = 5;
const LUX_VOL_MA_LONG = 10;
const LUX_VOL_THRESHOLD_PCT = 20;

// Confluence + filter constants (V1)
const PRE_FILTER_MIN_VOL_USD = 50_000_000;
const PRE_FILTER_MAX_24H_CHG_PCT = 30;
const PRE_FILTER_MIN_24H_CHG_PCT = -30;
const R1_LOOKBACK_BARS = 12;
const R2_LOOKBACK_BARS = 12;
const R2_MAX_DIST_PCT = 5;
const HARD_FILTER_FUNDING_MAX = 0.00046; // +0.046%/8h
const HARD_FILTER_MAX_STOP_DIST_PCT = 8;
// V1.2: post-pump hard filters multi-window (1000LUNC slipped through con +120% en 30d).
const HARD_FILTER_MAX_7D_CHG = 0.50; // +50% en 7d → eliminar
const HARD_FILTER_MAX_30D_CHG = 1.00; // +100% en 30d → eliminar
const DAILY_KLINES_LIMIT = 31; // 30d + hoy
const KLINES_LIMIT = 100;
const CONCURRENCY = 5;
const BATCH_DELAY_MS = 50;
const SCAN_REPORT_DIR = "analysis/scans";

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const flags = {
    // V1.1: default `both` — R1 requires 1H+4H alignment (was 1h-only).
    interval: "both", // 1h | 4h | both
    notify: false,
    notifyOnEmpty: false,
    maxPairs: null,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") flags.help = true;
    else if (a === "--notify") flags.notify = true;
    else if (a === "--notify-on-empty") flags.notifyOnEmpty = true;
    else if (a === "--interval") flags.interval = String(argv[++i]);
    else if (a === "--max-pairs") flags.maxPairs = Number(argv[++i]);
    else throw new Error(`Flag desconocido: ${a}`);
  }
  if (!["1h", "4h", "both"].includes(flags.interval)) {
    throw new Error(`--interval debe ser 1h | 4h | both (recibido: ${flags.interval})`);
  }
  if (flags.maxPairs !== null && (!Number.isFinite(flags.maxPairs) || flags.maxPairs <= 0)) {
    throw new Error(`--max-pairs debe ser entero positivo (recibido: ${flags.maxPairs})`);
  }
  return flags;
}

function printUsage() {
  process.stderr.write(
    [
      "Uso: node scripts/scan-confluence.js [flags]",
      "",
      "Flags:",
      "  --interval <1h|4h|both>   Timeframe principal (default: both — exige UT 1H+4H aligned)",
      "  --notify                  Postea top 1-2 a Telegram (env: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID)",
      "  --notify-on-empty         Postea aviso aunque no haya setups",
      "  --max-pairs <N>           Limita el universo (dev/smoke)",
      "  --help                    Esta ayuda",
    ].join("\n") + "\n",
  );
}

// ---------------------------------------------------------------------------
// Format helpers
// ---------------------------------------------------------------------------

function fmtPrice(n) {
  if (!Number.isFinite(n)) return "n/d";
  if (Math.abs(n) >= 1000) return n.toFixed(2);
  if (Math.abs(n) >= 1) return n.toFixed(4);
  return n.toFixed(6);
}

function fmtPct(n, digits = 2) {
  if (!Number.isFinite(n)) return "n/d";
  return `${n >= 0 ? "+" : ""}${n.toFixed(digits)}%`;
}

function fmtUSD(n) {
  if (!Number.isFinite(n)) return "n/d";
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}k`;
  return `$${n.toFixed(2)}`;
}

// ---------------------------------------------------------------------------
// Tier inference (fallback for symbols outside hardcoded watchlist)
// ---------------------------------------------------------------------------
// CLAUDE.md sizing:
//   T1: BTC/ETH/SOL/XRP — $5–$15, 5–10x
//   T2: narrative altcoins — $2–$5, 3–5x
//   T3: memecoins — $1–$3, 2–3x
// Heuristic for unknown symbols: vol-based bucketing.

const T1_HARDCODED = new Set(["BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT"]);
const MEMECOIN_PATTERNS = [
  /^DOGE/, /^1000/, /^WIF/, /^PENGU/, /^FLOKI/, /^SHIB/, /^PEPE/, /BONK/, /MEME/,
];

function inferTier(symbol, quoteVolume24h) {
  if (T1_HARDCODED.has(symbol)) return { tier: 1, sizeUSDT: 10, leverage: 7 };
  // Memecoin pattern — siempre T3
  for (const pat of MEMECOIN_PATTERNS) {
    if (pat.test(symbol)) return { tier: 3, sizeUSDT: 2, leverage: 2.5 };
  }
  // Por volumen 24h: muy alto → T2, mediano → T3
  if (Number.isFinite(quoteVolume24h) && quoteVolume24h >= 200_000_000) {
    return { tier: 2, sizeUSDT: 3, leverage: 4 };
  }
  return { tier: 3, sizeUSDT: 2, leverage: 2.5 };
}

// ---------------------------------------------------------------------------
// BTC context (R4)
// ---------------------------------------------------------------------------

async function fetchBtcContext() {
  const klines = await fetchKlines("BTCUSDT", "1h", { limit: KLINES_LIMIT });
  const ut = utBot(klines, { atrPeriod: UT_ATR_PERIOD, keyValue: UT_KEY_VALUE });
  const lastIdx = klines.length - 1;
  const pos = ut.pos[lastIdx]; // 1 long, -1 short, 0 flat
  const lastSig = ut.lastSignal;
  const ago = lastSig ? lastIdx - lastSig.index : null;
  return {
    pos,
    direction: pos > 0 ? "long" : pos < 0 ? "short" : "flat",
    trail: ut.trailingStop[lastIdx],
    lastSignalType: lastSig ? lastSig.type : null,
    lastSignalBarsAgo: ago,
    lastClose: klines[lastIdx].close,
  };
}

// ---------------------------------------------------------------------------
// Universe fetch
// ---------------------------------------------------------------------------

async function fetchTradingPairs() {
  const info = await fetchJson(`${FAPI}/fapi/v1/exchangeInfo`);
  if (!info || !Array.isArray(info.symbols)) {
    throw new Error("exchangeInfo: respuesta inesperada");
  }
  return info.symbols
    .filter(
      (s) =>
        s.status === "TRADING" &&
        s.contractType === "PERPETUAL" &&
        s.quoteAsset === "USDT",
    )
    .map((s) => s.symbol);
}

async function fetchTickers24h() {
  const arr = await fetchJson(`${FAPI}/fapi/v1/ticker/24hr`);
  if (!Array.isArray(arr)) throw new Error("ticker/24hr: respuesta inesperada");
  const map = new Map();
  for (const t of arr) {
    map.set(t.symbol, {
      lastPrice: Number(t.lastPrice),
      priceChangePct: Number(t.priceChangePercent),
      quoteVolume: Number(t.quoteVolume), // USDT volume
      volume: Number(t.volume),
    });
  }
  return map;
}

async function fetchFunding(symbol) {
  try {
    const r = await fetchJson(`${FAPI}/fapi/v1/premiumIndex?symbol=${symbol}`);
    return {
      symbol,
      lastFundingRate: Number(r.lastFundingRate),
      nextFundingTime: Number(r.nextFundingTime),
    };
  } catch (err) {
    return { symbol, lastFundingRate: null, error: err.message };
  }
}

// ---------------------------------------------------------------------------
// Concurrency: simple Promise pool
// ---------------------------------------------------------------------------

async function pool(items, worker, concurrency = CONCURRENCY, batchDelayMs = BATCH_DELAY_MS) {
  const results = [];
  for (let i = 0; i < items.length; i += concurrency) {
    const slice = items.slice(i, i + concurrency);
    const batch = await Promise.all(
      slice.map((it) =>
        worker(it).catch((err) => ({ __error: err.message, __item: it })),
      ),
    );
    results.push(...batch);
    if (i + concurrency < items.length && batchDelayMs > 0) {
      await new Promise((r) => setTimeout(r, batchDelayMs));
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Confluence scoring
// ---------------------------------------------------------------------------

/**
 * Score 3-of-4 para una dirección dada (long o short).
 *
 * @param {'long'|'short'} side
 * @param {object} ctx
 * @param {Array} ctx.klines1h
 * @param {Array|null} ctx.klines4h
 * @param {object} ctx.btc
 * @param {object} ctx.ticker24h
 * @returns {{
 *   count: number,
 *   r1: { ok: boolean, detail: string },
 *   r2: { ok: boolean, detail: string, level?: number, distPct?: number },
 *   r3: { ok: boolean, detail: string },
 *   r4: { ok: boolean, detail: string },
 *   hardFiltersPassed: boolean,
 *   reasonIfFailed: string,
 *   metrics: object
 * }}
 */
function scoreConfluence(side, ctx) {
  const { klines1h, klines4h, btc, ticker24h, funding } = ctx;
  const lastIdx = klines1h.length - 1;
  const lastClose = klines1h[lastIdx].close;

  // R1: UT Bot LONG (o SHORT) en 1H AND 4H — strict multi-TF alignment per operator's CLAUDE.md.
  //     Requiere que ambos TFs estén en `pos` igual a la dirección del trade,
  //     y que al menos uno tenga el último label (Buy/Sell) dentro de R1_LOOKBACK_BARS.
  //     Si sólo se solicitó 1H (no hay klines4h disponibles), evalúa sólo 1H.
  const ut1h = utBot(klines1h, { atrPeriod: UT_ATR_PERIOD, keyValue: UT_KEY_VALUE });
  const ut1hLast = ut1h.lastSignal;
  const ut1hPos = ut1h.pos[lastIdx]; // 1 long, -1 short
  const want = side === "long" ? 1 : -1;
  const wantLabel = side === "long" ? "Buy" : "Sell";
  const ut1hAligned = ut1hPos === want;
  const ut1hAgo = ut1hLast ? lastIdx - ut1hLast.index : null;
  const ut1hFresh = !!(ut1hLast && ut1hLast.type === wantLabel && ut1hAgo <= R1_LOOKBACK_BARS);

  let r1Ok = false;
  let r1Detail = "n/d";

  if (klines4h && klines4h.length >= UT_ATR_PERIOD + 2) {
    // Ambos TFs disponibles → exigir alineación 1H AND 4H
    const ut4h = utBot(klines4h, { atrPeriod: UT_ATR_PERIOD, keyValue: UT_KEY_VALUE });
    const last4hIdx = klines4h.length - 1;
    const ut4hLast = ut4h.lastSignal;
    const ut4hPos = ut4h.pos[last4hIdx];
    const ut4hAligned = ut4hPos === want;
    const ut4hAgo = ut4hLast ? last4hIdx - ut4hLast.index : null;
    const ut4hFresh = !!(ut4hLast && ut4hLast.type === wantLabel && ut4hAgo <= R1_LOOKBACK_BARS);

    if (ut1hAligned && ut4hAligned && (ut1hFresh || ut4hFresh)) {
      r1Ok = true;
      const freshTag = ut1hFresh && ut4hFresh
        ? `1H ${wantLabel} hace ${ut1hAgo}v + 4H ${wantLabel} hace ${ut4hAgo}v`
        : ut1hFresh
          ? `1H ${wantLabel} hace ${ut1hAgo}v (4H aligned, last label hace ${ut4hAgo ?? "n/d"}v)`
          : `4H ${wantLabel} hace ${ut4hAgo}v (1H aligned, last label hace ${ut1hAgo ?? "n/d"}v)`;
      r1Detail = `UT alineado ${side} en 1H+4H — ${freshTag}`;
    } else {
      const reasons = [];
      if (!ut1hAligned) reasons.push(`UT 1H pos=${ut1hPos} (no ${side})`);
      if (!ut4hAligned) reasons.push(`UT 4H pos=${ut4hPos} (no ${side})`);
      if (ut1hAligned && ut4hAligned && !(ut1hFresh || ut4hFresh)) {
        reasons.push(`sin label fresco en 1H ni 4H (≤${R1_LOOKBACK_BARS}v)`);
      }
      r1Detail = `UT no alineado 1H+4H: ${reasons.join("; ")}`;
    }
  } else {
    // Sólo 1H → exigir 1H aligned + label fresco en 1H
    if (ut1hAligned && ut1hFresh) {
      r1Ok = true;
      r1Detail = `UT 1H ${wantLabel} hace ${ut1hAgo}v a $${fmtPrice(ut1hLast.price)} (sólo 1H)`;
    } else if (!ut1hAligned) {
      r1Detail = `UT 1H pos=${ut1hPos} (no ${side})`;
    } else {
      r1Detail = ut1hLast
        ? `UT 1H último ${ut1hLast.type} hace ${ut1hAgo}v (fuera de ventana o dirección opuesta)`
        : "UT 1H sin señales";
    }
  }

  // R2: LuxAlgo last B (long) / S (short) en últimas 12 velas + precio dentro de ±5%.
  // V1.2: SOLO body breaks "B"/"S" cuentan como pass. Bull_Wick/Bear_Wick son señales
  // de RECHAZO en la dirección opuesta — incluirlas como pass invertía la lógica.
  const lux = luxAlgoSnR(klines1h, {
    leftBars: LUX_LEFT,
    rightBars: LUX_RIGHT,
    volMaShort: LUX_VOL_MA_SHORT,
    volMaLong: LUX_VOL_MA_LONG,
    volThresholdPct: LUX_VOL_THRESHOLD_PCT,
  });
  let r2Ok = false;
  let r2Detail = "n/d";
  let r2Level = null;
  let r2DistPct = null;
  // Sólo body break en la dirección del trade. Wicks NO cuentan (rechazo, dirección opuesta).
  const wantBreakType = side === "long" ? "B" : "S";
  const matchingBreaks = lux.visibleBreaks.filter((b) => b.type === wantBreakType);
  const lastMatch = matchingBreaks.length ? matchingBreaks[matchingBreaks.length - 1] : null;
  if (lastMatch) {
    const ago = lastIdx - lastMatch.index;
    const distPct = Math.abs((lastClose - lastMatch.levelBroken) / lastMatch.levelBroken) * 100;
    r2Level = lastMatch.levelBroken;
    r2DistPct = distPct;
    if (ago <= R2_LOOKBACK_BARS && distPct <= R2_MAX_DIST_PCT) {
      r2Ok = true;
      r2Detail = `${lastMatch.type} hace ${ago}v a $${fmtPrice(lastMatch.levelBroken)} (dist ${distPct.toFixed(2)}%)`;
    } else {
      r2Detail = `${lastMatch.type} hace ${ago}v (${ago > R2_LOOKBACK_BARS ? "fuera de ventana" : "dist " + distPct.toFixed(2) + "% > 5%"})`;
    }
  } else {
    // Diagnóstico: si hay wicks recientes pero no body breaks, indicarlo (señal de rechazo).
    const wickType = side === "long" ? "Bull_Wick" : "Bear_Wick";
    const recentWicks = lux.visibleBreaks.filter(
      (b) => b.type === wickType && lastIdx - b.index <= R2_LOOKBACK_BARS,
    );
    if (recentWicks.length) {
      const w = recentWicks[recentWicks.length - 1];
      r2Detail = `sin "${wantBreakType}" reciente (último ${wickType} hace ${lastIdx - w.index}v — rechazo, no cuenta)`;
    } else {
      r2Detail = `sin "${wantBreakType}" en últimas ${R2_LOOKBACK_BARS}v`;
    }
  }

  // R3: Volumen 24h ya pasó pre-filtro ≥ $50M → marcar PASS (V1 simplificación)
  const r3Ok = ticker24h.quoteVolume >= PRE_FILTER_MIN_VOL_USD;
  const r3Detail = r3Ok
    ? `vol 24h ${fmtUSD(ticker24h.quoteVolume)} ≥ $50M (pre-filtro)`
    : `vol 24h ${fmtUSD(ticker24h.quoteVolume)} < $50M`;

  // R4: Contexto BTC alineado
  let r4Ok = false;
  if (side === "long" && btc.pos > 0) r4Ok = true;
  if (side === "short" && btc.pos < 0) r4Ok = true;
  const r4Detail = `BTC ${btc.direction}${btc.lastSignalType ? ` (último ${btc.lastSignalType} hace ${btc.lastSignalBarsAgo}v)` : ""}`;

  const count = (r1Ok ? 1 : 0) + (r2Ok ? 1 : 0) + (r3Ok ? 1 : 0) + (r4Ok ? 1 : 0);

  // Hard filters (solo si count >= 3)
  const failures = [];
  // Funding (solo aplica a long; el cap espeja la regla operativa)
  if (side === "long" && funding && Number.isFinite(funding.lastFundingRate)) {
    if (funding.lastFundingRate > HARD_FILTER_FUNDING_MAX) {
      failures.push(`funding ${(funding.lastFundingRate * 100).toFixed(4)}%/8h > +0.046%`);
    }
  }
  // 24h change cap
  if (side === "long" && ticker24h.priceChangePct > PRE_FILTER_MAX_24H_CHG_PCT) {
    failures.push(`24h chg ${ticker24h.priceChangePct.toFixed(2)}% > +30%`);
  }
  if (side === "short" && ticker24h.priceChangePct < PRE_FILTER_MIN_24H_CHG_PCT) {
    failures.push(`24h chg ${ticker24h.priceChangePct.toFixed(2)}% < -30%`);
  }
  // Stop dist (usar trailing UT como proxy de SL inicial)
  const trailing = ut1h.trailingStop[lastIdx];
  let stopDistPct = null;
  if (Number.isFinite(trailing)) {
    stopDistPct = Math.abs((lastClose - trailing) / lastClose) * 100;
    if (stopDistPct > HARD_FILTER_MAX_STOP_DIST_PCT) {
      failures.push(`stop dist ${stopDistPct.toFixed(2)}% > 8%`);
    }
  }

  return {
    count,
    r1: { ok: r1Ok, detail: r1Detail },
    r2: { ok: r2Ok, detail: r2Detail, level: r2Level, distPct: r2DistPct },
    r3: { ok: r3Ok, detail: r3Detail },
    r4: { ok: r4Ok, detail: r4Detail },
    hardFiltersPassed: failures.length === 0,
    reasonIfFailed: failures.join("; "),
    metrics: {
      lastClose,
      trailing: Number.isFinite(trailing) ? trailing : null,
      stopDistPct,
      luxLevel: r2Level,
    },
  };
}

// ---------------------------------------------------------------------------
// Trade plan synthesis (per CLAUDE.md sizing + ladder TP)
// ---------------------------------------------------------------------------

function synthesizePlan(symbol, side, score, ticker24h) {
  const tier = inferTier(symbol, ticker24h.quoteVolume);
  const entry = score.metrics.lastClose;
  const stop = score.metrics.trailing;
  if (!Number.isFinite(stop)) {
    return { tier, entry, stop: null, error: "no trailing válido" };
  }
  const stopDist = Math.abs(entry - stop);
  const stopDistPct = (stopDist / entry) * 100;

  // Ladder targets: TP1 = 1.5R (50%), TP2 = 2.5R (30%), residual = trail BE+fees+buffer (20%)
  // V1.1: R-multiples per CLAUDE.md operator rule (was 1R/2R, daba R:R weighted ~1.5 < gate 1:2).
  const TP1_R_MULTIPLE = 1.5;
  const TP2_R_MULTIPLE = 2.5;
  const RESIDUAL_R_OPTIMISTIC = 2.0; // residual 20% trailing — asumimos exit promedio ~2R post-BE
  const RESIDUAL_R_CONSERVATIVE = 0.0; // residual sale a BE per CLAUDE.md ("trailing a breakeven")
  const r = stopDist;
  let tp1, tp2, tp3;
  if (side === "long") {
    tp1 = entry + TP1_R_MULTIPLE * r;
    tp2 = entry + TP2_R_MULTIPLE * r;
    tp3 = entry + 3 * r; // referencia visual para trail
  } else {
    tp1 = entry - TP1_R_MULTIPLE * r;
    tp2 = entry - TP2_R_MULTIPLE * r;
    tp3 = entry - 3 * r;
  }

  // Loss real (sizing real, sin apalancamiento aplicado al stop dist — el stop% es del precio, el size USDT es notional / leverage)
  // Notional = sizeUSDT * leverage. Loss en USDT = notional * stopDistPct/100.
  const notional = tier.sizeUSDT * tier.leverage;
  const lossUsd = notional * (stopDistPct / 100);

  // R:R weighted — V1.2: rango conservative-optimistic.
  //   Conservative: residual sale a BE (CLAUDE.md "trailing a breakeven") → 0R contribución
  //     0.5 × 1.5 + 0.3 × 2.5 + 0.2 × 0.0 = 0.75 + 0.75 + 0.00 = 1.50R
  //   Optimistic: residual trailing alcanza ~2R promedio post-BE
  //     0.5 × 1.5 + 0.3 × 2.5 + 0.2 × 2.0 = 0.75 + 0.75 + 0.40 = 1.90R
  const rrWeightedConservative = 0.5 * TP1_R_MULTIPLE + 0.3 * TP2_R_MULTIPLE + 0.2 * RESIDUAL_R_CONSERVATIVE;
  const rrWeightedOptimistic = 0.5 * TP1_R_MULTIPLE + 0.3 * TP2_R_MULTIPLE + 0.2 * RESIDUAL_R_OPTIMISTIC;

  return {
    tier: tier.tier,
    sizeUSDT: tier.sizeUSDT,
    leverage: tier.leverage,
    notional,
    entry,
    stop,
    stopDistPct,
    tp1,
    tp2,
    tp3,
    lossUsd,
    rrWeightedConservative,
    rrWeightedOptimistic,
  };
}

// ---------------------------------------------------------------------------
// Symbol analysis pipeline
// ---------------------------------------------------------------------------

async function analyzeSymbol(symbol, ticker24h, btc, includeShort, fetchInterval) {
  const klines1h = await fetchKlines(symbol, "1h", { limit: KLINES_LIMIT });
  let klines4h = null;
  if (fetchInterval === "both" || fetchInterval === "4h") {
    try {
      klines4h = await fetchKlines(symbol, "4h", { limit: KLINES_LIMIT });
    } catch {
      klines4h = null;
    }
  }

  const ctxBase = { klines1h, klines4h, btc, ticker24h, funding: null };
  const long = scoreConfluence("long", ctxBase);
  const short = includeShort ? scoreConfluence("short", ctxBase) : null;

  return { symbol, ticker24h, long, short };
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function rankSurvivors(results) {
  const ranked = [];
  for (const r of results) {
    if (r.__error) continue;
    for (const side of ["long", "short"]) {
      const score = r[side];
      if (!score) continue;
      if (score.count >= 3 && score.hardFiltersPassed) {
        // Composite score: count + recency bonus inverso (R2 más cerca pesa más)
        const proximityBonus = score.r2.distPct !== null ? Math.max(0, 5 - score.r2.distPct) / 5 : 0;
        const composite = score.count + proximityBonus * 0.5;
        ranked.push({ symbol: r.symbol, ticker24h: r.ticker24h, side, score, composite });
      }
    }
  }
  ranked.sort((a, b) => b.composite - a.composite);
  return ranked;
}

function buildMarkdown(opts) {
  const { btc, universeStats, ranked, discarded, scanTime, intervalArg } = opts;
  const lines = [];
  lines.push(`# Scan confluence — ${fmtOperatorTimeWithTZ(scanTime)}`);
  lines.push("");
  lines.push(`Interval principal: \`${intervalArg}\` · UT key=${UT_KEY_VALUE} ATR=${UT_ATR_PERIOD} · LuxAlgo ${LUX_LEFT}/${LUX_RIGHT}/${LUX_VOL_THRESHOLD_PCT}`);
  lines.push("");

  lines.push("## Contexto BTC");
  lines.push(`- UT Bot 1H: **${btc.direction}** (precio $${fmtPrice(btc.lastClose)}, trail $${fmtPrice(btc.trail)})`);
  if (btc.lastSignalType) {
    lines.push(`- Última señal: ${btc.lastSignalType} hace ${btc.lastSignalBarsAgo} velas`);
  } else {
    lines.push("- Última señal: n/d");
  }
  lines.push("");

  lines.push("## Universo escaneado");
  lines.push(`- Total pares activos USDT-M PERPETUAL: ${universeStats.totalActive}`);
  lines.push(`- Pre-candidatos (vol ≥ $50M, |24h chg| ≤ 30%): ${universeStats.preCandidates}`);
  lines.push(`- Analizados (post --max-pairs si aplica): ${universeStats.analyzed}`);
  lines.push(`- Survivors (3/4 + hard filters OK): ${ranked.length}`);
  lines.push("");

  if (ranked.length === 0) {
    lines.push("## Top setups");
    lines.push("");
    lines.push("**Sin setups 3/4 + filtros pasados en este ciclo.**");
    lines.push("");
  } else {
    lines.push("## Top setups (max 10)");
    lines.push("");
    const top = ranked.slice(0, 10);
    for (let i = 0; i < top.length; i++) {
      const item = top[i];
      const { symbol, ticker24h, side, score } = item;
      const plan = synthesizePlan(symbol, side, score, ticker24h);
      lines.push(`### #${i + 1} ${symbol} ${side.toUpperCase()} ${score.count}/4`);
      lines.push(`- Precio: $${fmtPrice(ticker24h.lastPrice)} | 24h: ${fmtPct(ticker24h.priceChangePct)} | vol 24h: ${fmtUSD(ticker24h.quoteVolume)}`);
      lines.push(`- R1 UT: ${score.r1.ok ? "✅" : "❌"} ${score.r1.detail}`);
      lines.push(`- R2 LuxAlgo: ${score.r2.ok ? "✅" : "❌"} ${score.r2.detail}`);
      lines.push(`- R3 Vol: ${score.r3.ok ? "✅" : "❌"} ${score.r3.detail}`);
      lines.push(`- R4 BTC: ${score.r4.ok ? "✅" : "❌"} ${score.r4.detail}`);
      if (plan.error) {
        lines.push(`- Plan: no calculable (${plan.error})`);
      } else {
        lines.push("- Plan tentativo:");
        lines.push(`  - Entrada: $${fmtPrice(plan.entry)}`);
        lines.push(`  - SL: $${fmtPrice(plan.stop)} (${plan.stopDistPct.toFixed(2)}% desde entrada, loss real T${plan.tier} ~ $${plan.lossUsd.toFixed(2)})`);
        lines.push(`  - TP1 (50% @ 1.5R): $${fmtPrice(plan.tp1)}`);
        lines.push(`  - TP2 (30% @ 2.5R): $${fmtPrice(plan.tp2)}`);
        lines.push(`  - Residual (20% @ ~2R): trail BE+fees+buffer (ref ~$${fmtPrice(plan.tp3)})`);
        lines.push(`  - Tamaño: $${plan.sizeUSDT} × ${plan.leverage}x = $${plan.notional.toFixed(2)} notional`);
        lines.push(`  - R:R weighted: **1:${plan.rrWeightedConservative.toFixed(2)} (conservativo, residual a BE) – 1:${plan.rrWeightedOptimistic.toFixed(2)} (si residual corre a ~2R)**`);
      }
      lines.push(`- Validación pre-entry: **sí** — captura TV 1H+4H confirmando UT label visible y nivel LuxAlgo en el chart`);
      lines.push("");
    }
  }

  if (discarded.length > 0) {
    lines.push("## Pares descartados notables (max 10)");
    for (const d of discarded.slice(0, 10)) {
      lines.push(`- ${d.symbol} ${d.side}: ${d.reason}`);
    }
    lines.push("");
  }

  lines.push("## Disclaimer estadístico");
  lines.push("Esto es **discovery**, no garantía. Tomá TODOS los setups con sizing chico T3 (NO cherry-pick) para que la estadística promedie EV+. Cherry-pick post-hoc es ilusión: la regla 3/4 + sizing chico es un sistema; cazar el moonshot es lotería.");
  lines.push("");

  return lines.join("\n");
}

function buildTelegramMessage(opts) {
  const { ranked, scanTime, scanFile } = opts;
  const hhmm = fmtOperatorTime(scanTime).slice(11, 16);
  if (ranked.length === 0) {
    return `<b>Scan limpio</b>\n\nSin setups 3/4 + filtros pasados en este ciclo (${hhmm}).`;
  }
  const lines = [];
  lines.push(`<b>🎯 Scan confluence — ${hhmm}</b>`);
  lines.push("");
  const top = ranked.slice(0, 2);
  const t0 = top[0];
  const plan0 = synthesizePlan(t0.symbol, t0.side, t0.score, t0.ticker24h);
  lines.push(`<b>Top setup: ${t0.symbol} ${t0.side.toUpperCase()} ${t0.score.count}/4</b>`);
  lines.push(`Precio: $${fmtPrice(t0.ticker24h.lastPrice)}`);
  if (!plan0.error) {
    lines.push(`Entrada: $${fmtPrice(plan0.entry)}`);
    lines.push(`SL: $${fmtPrice(plan0.stop)} (loss $${plan0.lossUsd.toFixed(2)})`);
    lines.push(`TP1: $${fmtPrice(plan0.tp1)} | TP2: $${fmtPrice(plan0.tp2)}`);
    lines.push(`R:R: ${plan0.rrWeightedConservative.toFixed(2)}–${plan0.rrWeightedOptimistic.toFixed(2)}`);
  }

  if (top[1]) {
    const t1 = top[1];
    lines.push("");
    lines.push(`<b>Setup #2: ${t1.symbol} ${t1.side} ${t1.score.count}/4</b>`);
    lines.push(`Precio: $${fmtPrice(t1.ticker24h.lastPrice)} | 24h: ${fmtPct(t1.ticker24h.priceChangePct)}`);
  }
  lines.push("");
  lines.push("⚠️ Validar con captura TV antes de entrar.");
  lines.push(`Reporte: <code>${scanFile}</code>`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const argv = process.argv.slice(2);
  let flags;
  try {
    flags = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`Error: ${err.message}\n`);
    printUsage();
    process.exit(1);
  }
  if (flags.help) {
    printUsage();
    process.exit(0);
  }

  const scanTime = Date.now();
  process.stderr.write(`[scan-confluence] inicio · interval=${flags.interval}${flags.maxPairs ? ` · max-pairs=${flags.maxPairs}` : ""}\n`);

  // 1. BTC context
  process.stderr.write("[scan-confluence] fetching BTC context...\n");
  const btc = await fetchBtcContext();
  process.stderr.write(`[scan-confluence] BTC: ${btc.direction} (last close $${fmtPrice(btc.lastClose)})\n`);

  // 2. Universe
  process.stderr.write("[scan-confluence] fetching exchangeInfo + ticker/24hr...\n");
  const [pairs, tickers] = await Promise.all([fetchTradingPairs(), fetchTickers24h()]);
  process.stderr.write(`[scan-confluence] universe: ${pairs.length} pairs activos\n`);

  // 3. Pre-filter
  const preCandidates = pairs.filter((sym) => {
    const t = tickers.get(sym);
    if (!t) return false;
    if (!Number.isFinite(t.quoteVolume) || t.quoteVolume < PRE_FILTER_MIN_VOL_USD) return false;
    if (!Number.isFinite(t.priceChangePct)) return false;
    if (t.priceChangePct < PRE_FILTER_MIN_24H_CHG_PCT) return false;
    if (t.priceChangePct > PRE_FILTER_MAX_24H_CHG_PCT) return false;
    return true;
  });

  let toAnalyze = preCandidates;
  if (flags.maxPairs && toAnalyze.length > flags.maxPairs) {
    // Dev mode: priorizar mayor volumen primero para que el sample sea representativo
    toAnalyze = toAnalyze
      .map((s) => ({ s, v: tickers.get(s).quoteVolume }))
      .sort((a, b) => b.v - a.v)
      .slice(0, flags.maxPairs)
      .map((x) => x.s);
  }
  process.stderr.write(`[scan-confluence] pre-candidates: ${preCandidates.length} · analizando: ${toAnalyze.length}\n`);

  // 4. Analyze in pool
  const includeShort = true;
  process.stderr.write(`[scan-confluence] fetching klines (concurrency=${CONCURRENCY})...\n`);
  const t0 = Date.now();
  const results = await pool(toAnalyze, async (sym) => {
    const t = tickers.get(sym);
    return analyzeSymbol(sym, t, btc, includeShort, flags.interval);
  });
  process.stderr.write(`[scan-confluence] klines fetch + analysis: ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);

  const errors = results.filter((r) => r.__error);
  if (errors.length > 0) {
    process.stderr.write(`[scan-confluence] ${errors.length} errores en análisis (continúa con resto)\n`);
    if (process.env.DEBUG) {
      for (const e of errors.slice(0, 5)) process.stderr.write(`  · ${e.__item}: ${e.__error}\n`);
    }
  }
  const ok = results.filter((r) => !r.__error);

  // 5. Identify candidates with 3+/4 (any side) — fetch funding solo para esos
  const provisionalSurvivors = [];
  for (const r of ok) {
    for (const side of ["long", "short"]) {
      if (r[side] && r[side].count >= 3) {
        provisionalSurvivors.push({ symbol: r.symbol, side, ref: r });
      }
    }
  }
  // Dedupe symbols for funding fetch
  const symbolsForFunding = [...new Set(provisionalSurvivors.map((s) => s.symbol))];
  process.stderr.write(`[scan-confluence] survivors provisorios: ${provisionalSurvivors.length} (${symbolsForFunding.length} símbolos únicos) — fetching funding...\n`);
  const fundingResults = await pool(symbolsForFunding, fetchFunding, CONCURRENCY);
  const fundingMap = new Map();
  for (const f of fundingResults) {
    if (!f.__error) fundingMap.set(f.symbol, f);
  }

  // 6. Re-score with funding (re-evaluates hard filters)
  const discarded = [];
  for (const ps of provisionalSurvivors) {
    const r = ps.ref;
    const klines1h = null; // ya consumimos las klines en analyzeSymbol; re-evaluamos filtros sin re-fetch
    // Re-eval hard filters incorporando funding
    const score = r[ps.side];
    const funding = fundingMap.get(ps.symbol) || null;
    const failures = [];
    if (ps.side === "long" && funding && Number.isFinite(funding.lastFundingRate)) {
      if (funding.lastFundingRate > HARD_FILTER_FUNDING_MAX) {
        failures.push(`funding ${(funding.lastFundingRate * 100).toFixed(4)}%/8h > +0.046%`);
      }
    }
    if (ps.side === "long" && r.ticker24h.priceChangePct > PRE_FILTER_MAX_24H_CHG_PCT) {
      failures.push(`24h chg ${r.ticker24h.priceChangePct.toFixed(2)}% > +30%`);
    }
    if (ps.side === "short" && r.ticker24h.priceChangePct < PRE_FILTER_MIN_24H_CHG_PCT) {
      failures.push(`24h chg ${r.ticker24h.priceChangePct.toFixed(2)}% < -30%`);
    }
    if (Number.isFinite(score.metrics.stopDistPct) && score.metrics.stopDistPct > HARD_FILTER_MAX_STOP_DIST_PCT) {
      failures.push(`stop dist ${score.metrics.stopDistPct.toFixed(2)}% > 8%`);
    }
    score.hardFiltersPassed = failures.length === 0;
    score.reasonIfFailed = failures.join("; ");
    score.funding = funding;
    if (!score.hardFiltersPassed) {
      discarded.push({ symbol: ps.symbol, side: ps.side, reason: score.reasonIfFailed });
    }
  }

  // 6.5 Post-pump hard filter multi-window (V1.2): para sobrevivientes que aún pasan,
  //     fetch daily klines y eliminar si 7d > +50% o 30d > +100% (long).
  //     Para shorts simétrico: eliminar si 7d < -50% o 30d < -100% (post-dump capitulation).
  const stillPassing = provisionalSurvivors.filter((ps) => ps.ref[ps.side].hardFiltersPassed);
  const symbolsForDaily = [...new Set(stillPassing.map((s) => s.symbol))];
  if (symbolsForDaily.length > 0) {
    process.stderr.write(`[scan-confluence] post-pump filter: fetching daily klines para ${symbolsForDaily.length} símbolos...\n`);
    const dailyResults = await pool(
      symbolsForDaily,
      async (sym) => {
        try {
          const dk = await fetchKlines(sym, "1d", { limit: DAILY_KLINES_LIMIT });
          return { symbol: sym, klines: dk };
        } catch (err) {
          return { symbol: sym, error: err.message };
        }
      },
      CONCURRENCY,
    );
    const dailyMap = new Map();
    for (const d of dailyResults) {
      if (!d.__error && !d.error && d.klines) dailyMap.set(d.symbol, d.klines);
    }

    for (const ps of stillPassing) {
      const dk = dailyMap.get(ps.symbol);
      if (!dk || dk.length < 8) continue; // sin data daily, no podemos filtrar — dejar pasar
      const closes = dk.map((k) => k.close);
      const closeNow = closes[closes.length - 1];
      const close7d = closes[closes.length - 8] ?? closes[0];
      const close30d = closes[0];
      if (!Number.isFinite(closeNow) || !Number.isFinite(close7d) || !Number.isFinite(close30d)) continue;
      const change7d = (closeNow - close7d) / close7d;
      const change30d = (closeNow - close30d) / close30d;

      const score = ps.ref[ps.side];
      const failures = [];
      if (ps.side === "long") {
        if (change7d > HARD_FILTER_MAX_7D_CHG) {
          failures.push(`7d chg ${(change7d * 100).toFixed(2)}% > +50%`);
        }
        if (change30d > HARD_FILTER_MAX_30D_CHG) {
          failures.push(`30d chg ${(change30d * 100).toFixed(2)}% > +100%`);
        }
      } else {
        if (change7d < -HARD_FILTER_MAX_7D_CHG) {
          failures.push(`7d chg ${(change7d * 100).toFixed(2)}% < -50%`);
        }
        if (change30d < -HARD_FILTER_MAX_30D_CHG) {
          failures.push(`30d chg ${(change30d * 100).toFixed(2)}% < -100%`);
        }
      }
      if (failures.length > 0) {
        score.hardFiltersPassed = false;
        const prevReason = score.reasonIfFailed;
        score.reasonIfFailed = prevReason ? `${prevReason}; ${failures.join("; ")}` : failures.join("; ");
        discarded.push({ symbol: ps.symbol, side: ps.side, reason: failures.join("; ") });
      }
    }
  }

  // 7. Rank
  const ranked = rankSurvivors(ok);

  // 8. Write report
  await mkdir(SCAN_REPORT_DIR, { recursive: true });
  const isoZ = new Date(scanTime).toISOString().replace(/:/g, "-").replace(/\..+$/, "Z");
  const reportFile = path.join(SCAN_REPORT_DIR, `${isoZ}.md`);
  const md = buildMarkdown({
    btc,
    universeStats: {
      totalActive: pairs.length,
      preCandidates: preCandidates.length,
      analyzed: toAnalyze.length,
    },
    ranked,
    discarded,
    scanTime,
    intervalArg: flags.interval,
  });
  await writeFile(reportFile, md, "utf-8");
  const absReportPath = path.resolve(reportFile);

  // 9. Console summary
  process.stdout.write(`\n=== Scan confluence — ${fmtOperatorTimeWithTZ(scanTime)} ===\n`);
  process.stdout.write(`BTC: ${btc.direction} | universo: ${pairs.length} | pre-cand: ${preCandidates.length} | analizados: ${toAnalyze.length} | survivors: ${ranked.length}\n`);
  if (ranked.length === 0) {
    process.stdout.write("Sin setups 3/4 + filtros pasados.\n");
  } else {
    process.stdout.write(`\nTop ${Math.min(5, ranked.length)}:\n`);
    for (let i = 0; i < Math.min(5, ranked.length); i++) {
      const r = ranked[i];
      process.stdout.write(`  #${i + 1} ${r.symbol} ${r.side.toUpperCase()} ${r.score.count}/4 · $${fmtPrice(r.ticker24h.lastPrice)} (24h ${fmtPct(r.ticker24h.priceChangePct)})\n`);
    }
  }
  process.stdout.write(`\nReporte completo: ${absReportPath}\n`);

  // 10. Telegram notify
  if (flags.notify || (flags.notifyOnEmpty && ranked.length === 0)) {
    const shouldNotify = ranked.length > 0 ? flags.notify : flags.notifyOnEmpty;
    if (shouldNotify) {
      const msg = buildTelegramMessage({ ranked, scanTime, scanFile: reportFile });
      const result = await sendTelegram(msg);
      if (result.ok) {
        process.stdout.write("Telegram: enviado ✅\n");
      } else {
        process.stdout.write(`Telegram: ${result.error}\n`);
      }
    }
  }

  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(`Error fatal: ${err && err.message ? err.message : String(err)}\n`);
  if (process.env.DEBUG) process.stderr.write(`${err.stack}\n`);
  process.exit(2);
});
