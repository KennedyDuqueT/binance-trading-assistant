#!/usr/bin/env node
// market-snapshot.js
// Resumen rápido del mercado para BTCUSDT, ETHUSDT, SOLUSDT en Binance Futures.
// Imprime precio, funding rate (1h) y ratio long/short de top traders.
// Smart money se reporta como "n/d (no aplica para perpetuos CEX)" — la skill
// on-chain de Binance solo cubre tokens DEX, no perpetuos CEX nativos.
//
// Uso:
//   node scripts/market-snapshot.js          # tabla en español
//   node scripts/market-snapshot.js --json   # JSON estructurado

import { fetchJson } from "./lib/http.js";

const SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT"];
const FAPI = "https://fapi.binance.com";
const SMART_MONEY_LABEL = "n/d (no aplica para perpetuos CEX)";

function parseArgs(argv) {
  const flags = { json: false };
  const unknown = [];
  for (const arg of argv) {
    if (arg === "--json") flags.json = true;
    else unknown.push(arg);
  }
  return { flags, unknown };
}

function usage() {
  process.stderr.write(
    "Uso: node scripts/market-snapshot.js [--json]\n" +
      "  Sin flags: imprime tabla en español.\n" +
      "  --json:    imprime JSON estructurado por símbolo.\n"
  );
}

async function fetchSymbol(symbol) {
  const [price, funding, longShort] = await Promise.all([
    fetchJson(`${FAPI}/fapi/v1/ticker/price?symbol=${symbol}`),
    fetchJson(`${FAPI}/fapi/v1/premiumIndex?symbol=${symbol}`),
    fetchJson(
      `${FAPI}/futures/data/topLongShortPositionRatio?symbol=${symbol}&period=1h&limit=1`
    ),
  ]);

  const ls = Array.isArray(longShort) && longShort.length > 0 ? longShort[0] : null;

  return {
    symbol,
    price: price && price.price ? price.price : null,
    fundingRate: funding && funding.lastFundingRate ? funding.lastFundingRate : null,
    nextFundingTime: funding && funding.nextFundingTime ? funding.nextFundingTime : null,
    longShortRatio: ls ? ls.longShortRatio : null,
    longAccount: ls ? ls.longAccount : null,
    shortAccount: ls ? ls.shortAccount : null,
    longShortTimestamp: ls ? ls.timestamp : null,
    smartMoney: SMART_MONEY_LABEL,
  };
}

function fmtPrice(p) {
  if (p === null || p === undefined) return "—";
  const n = Number(p);
  if (!Number.isFinite(n)) return String(p);
  // Usa hasta 4 decimales significativos para precios sub-1 USDT.
  if (n >= 1) return `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
  return `$${n.toPrecision(4)}`;
}

function fmtFunding(f) {
  if (f === null || f === undefined) return "—";
  const n = Number(f);
  if (!Number.isFinite(n)) return String(f);
  // lastFundingRate viene en escala decimal (0.0001 = 0.01%).
  return `${(n * 100).toFixed(4)}%`;
}

function fmtLongShort(record) {
  if (!record.longShortRatio) return "—";
  const lr = Number(record.longShortRatio);
  const la = record.longAccount ? (Number(record.longAccount) * 100).toFixed(1) : "—";
  const sa = record.shortAccount ? (Number(record.shortAccount) * 100).toFixed(1) : "—";
  const ratio = Number.isFinite(lr) ? lr.toFixed(2) : record.longShortRatio;
  return `${ratio} (long: ${la}%, short: ${sa}%)`;
}

function renderTable(records) {
  const ts = new Date().toISOString();
  const lines = [];
  lines.push(`# Snapshot de mercado — ${ts}`);
  lines.push("");
  lines.push("| Par | Precio | Funding (1h) | Long/Short | Smart money |");
  lines.push("|---|---|---|---|---|");
  for (const r of records) {
    lines.push(
      `| ${r.symbol} | ${fmtPrice(r.price)} | ${fmtFunding(r.fundingRate)} | ${fmtLongShort(r)} | ${r.smartMoney} |`
    );
  }
  lines.push("");
  lines.push("Notas:");
  lines.push("- Funding rate en escala porcentual (positivo = longs pagan a shorts).");
  lines.push("- Long/Short ratio de top traders (1h, top 20% por position).");
  lines.push("- Smart money no aplica para CEX perps (la skill on-chain es para tokens DEX).");
  return lines.join("\n");
}

async function main() {
  const argv = process.argv.slice(2);
  const { flags, unknown } = parseArgs(argv);

  if (unknown.length > 0) {
    process.stderr.write(`Argumento desconocido: ${unknown[0]}\n`);
    usage();
    process.exit(1);
  }

  let records;
  try {
    records = await Promise.all(SYMBOLS.map(fetchSymbol));
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    process.stderr.write(`Error: falló la consulta a Binance Futures — ${msg}\n`);
    process.exit(2);
  }

  if (flags.json) {
    const out = {};
    for (const r of records) {
      out[r.symbol] = {
        price: r.price,
        fundingRate: r.fundingRate,
        longShortRatio: r.longShortRatio,
        longAccount: r.longAccount,
        shortAccount: r.shortAccount,
        smartMoney: r.smartMoney,
      };
    }
    process.stdout.write(JSON.stringify(out, null, 2) + "\n");
    return;
  }

  process.stdout.write(renderTable(records) + "\n");
}

await main();
