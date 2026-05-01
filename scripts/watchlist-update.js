#!/usr/bin/env node
// watchlist-update.js
// Refresca precios de la watchlist (`analysis/watchlist.md`) y reporta %Δ
// vs la corrida anterior (estado en `analysis/.watchlist-state.json`).
//
// Formato esperado de `analysis/watchlist.md`:
//   - Secciones por tier con encabezado "## Tier 1", "## Tier 2", "## Tier 3".
//   - Tablas markdown donde la primera columna lista el par (ej. `| BTCUSDT |`).
//   - Filas de header (`| Par | Tier | ... |`) y separadores (`|---|---|`)
//     se ignoran.
// Si el formato cambia, ajustar la regex en `parseWatchlist`.
//
// Uso:
//   node scripts/watchlist-update.js          # tabla en español
//   node scripts/watchlist-update.js --json   # JSON estructurado

import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchJson } from "./lib/http.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = resolve(__dirname, "..");
const WATCHLIST_PATH = resolve(PROJECT_ROOT, "analysis/watchlist.md");
const STATE_PATH = resolve(PROJECT_ROOT, "analysis/.watchlist-state.json");
const STATE_VERSION = 1;
const FAPI = "https://fapi.binance.com";

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
    "Uso: node scripts/watchlist-update.js [--json]\n"
  );
}

/**
 * Parsea el markdown y devuelve [{ tier, pair }, ...].
 * - Detecta secciones por encabezado `## Tier N`.
 * - Captura pares en filas tipo `| BTCUSDT | ... |`.
 */
export function parseWatchlist(md) {
  const lines = md.split(/\r?\n/);
  const result = [];
  let currentTier = null;
  const tierRe = /^##\s+Tier\s+(\d+)/i;
  // Captura primera celda con símbolo USDT (mayúsculas/dígitos).
  const rowRe = /^\|\s*([A-Z0-9]+USDT)\s*\|/;

  for (const line of lines) {
    const tierMatch = line.match(tierRe);
    if (tierMatch) {
      currentTier = Number(tierMatch[1]);
      continue;
    }
    if (currentTier === null) continue;
    const rowMatch = line.match(rowRe);
    if (rowMatch) {
      const pair = rowMatch[1];
      if (pair === "Par") continue; // header guard (defensa)
      result.push({ tier: currentTier, pair });
    }
  }
  return result;
}

async function fetchPrice(pair) {
  const res = await fetchJson(`${FAPI}/fapi/v1/ticker/price?symbol=${pair}`);
  if (!res || !res.price) {
    throw new Error(`respuesta sin campo 'price' para ${pair}`);
  }
  return Number(res.price);
}

async function readPriorState() {
  try {
    const txt = await readFile(STATE_PATH, "utf8");
    const parsed = JSON.parse(txt);
    if (!parsed || typeof parsed !== "object") return null;
    return parsed;
  } catch (err) {
    if (err && err.code === "ENOENT") return null;
    // Estado corrupto: avisar a stderr y tratarlo como ausente.
    process.stderr.write(
      `Aviso: no se pudo leer ${STATE_PATH} — ${err.message}. Tratando como primera corrida.\n`
    );
    return null;
  }
}

async function writeNewState(state) {
  const dir = dirname(STATE_PATH);
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
  const tmp = `${STATE_PATH}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 2) + "\n", "utf8");
  await rename(tmp, STATE_PATH);
}

function fmtPrice(p) {
  if (p === null || p === undefined) return "—";
  const n = Number(p);
  if (!Number.isFinite(n)) return String(p);
  if (n >= 1) return `$${n.toLocaleString("en-US", { maximumFractionDigits: 4 })}`;
  return `$${n.toPrecision(4)}`;
}

function fmtDelta(d) {
  if (d === null || d === undefined || Number.isNaN(d)) return "—";
  const sign = d > 0 ? "+" : "";
  return `${sign}${d.toFixed(2)}%`;
}

function renderTable(records, prior, now) {
  const ts = now.toISOString();
  const lines = [];
  lines.push(`# Watchlist update — ${ts}`);
  lines.push("");
  if (prior && prior.recordedAt) {
    const prev = new Date(prior.recordedAt);
    const elapsedMs = now.getTime() - prev.getTime();
    const elapsedMin = Math.round(elapsedMs / 60_000);
    lines.push(`%Δ desde ${prior.recordedAt} (${elapsedMin}m)`);
  } else {
    lines.push("Primera corrida — no hay estado anterior, %Δ = —.");
  }
  lines.push("");
  lines.push(`| Tier | Par | Precio actual | %Δ desde ${prior?.recordedAt ?? "—"} | Última actualización |`);
  lines.push("|---|---|---|---|---|");
  for (const r of records) {
    if (r.error) {
      lines.push(`| ${r.tier} | ${r.pair} | ERROR | — | ${ts} |`);
      continue;
    }
    lines.push(
      `| ${r.tier} | ${r.pair} | ${fmtPrice(r.price)} | ${fmtDelta(r.deltaPct)} | ${ts} |`
    );
  }
  return lines.join("\n");
}

async function main() {
  const { flags, unknown } = parseArgs(process.argv.slice(2));
  if (unknown.length > 0) {
    process.stderr.write(`Argumento desconocido: ${unknown[0]}\n`);
    usage();
    process.exit(1);
  }

  let md;
  try {
    md = await readFile(WATCHLIST_PATH, "utf8");
  } catch (err) {
    process.stderr.write(`Error: no se pudo leer ${WATCHLIST_PATH} — ${err.message}\n`);
    process.exit(2);
  }

  const pairs = parseWatchlist(md);
  if (pairs.length === 0) {
    process.stderr.write(
      `Error: no se encontraron pares en ${WATCHLIST_PATH}. ¿Cambió el formato?\n`
    );
    process.exit(2);
  }

  const prior = await readPriorState();
  const priorPrices = (prior && prior.prices) || {};

  const settled = await Promise.allSettled(pairs.map((p) => fetchPrice(p.pair)));

  const now = new Date();
  const recordedAt = now.toISOString();

  const records = pairs.map((p, i) => {
    const s = settled[i];
    if (s.status === "rejected") {
      return {
        tier: p.tier,
        pair: p.pair,
        price: null,
        deltaPct: null,
        elapsedMin: null,
        recordedAt,
        error: s.reason && s.reason.message ? s.reason.message : String(s.reason),
      };
    }
    const price = s.value;
    const oldPrice = priorPrices[p.pair];
    let deltaPct = null;
    if (typeof oldPrice === "number" && oldPrice > 0) {
      deltaPct = ((price - oldPrice) / oldPrice) * 100;
    }
    let elapsedMin = null;
    if (prior && prior.recordedAt) {
      const prev = new Date(prior.recordedAt);
      elapsedMin = Math.round((now.getTime() - prev.getTime()) / 60_000);
    }
    return {
      tier: p.tier,
      pair: p.pair,
      price,
      deltaPct,
      elapsedMin,
      recordedAt,
    };
  });

  const failed = records.filter((r) => r.error);
  const ok = records.filter((r) => !r.error);

  if (ok.length === 0) {
    process.stderr.write(
      `Error: todas las consultas (${records.length}) fallaron. Última: ${failed[0]?.error ?? "?"}\n`
    );
    process.exit(2);
  }

  // Estado nuevo: solo guarda precios de pares OK.
  const newPrices = {};
  for (const r of ok) newPrices[r.pair] = r.price;
  const newState = {
    version: STATE_VERSION,
    recordedAt,
    prices: newPrices,
  };
  try {
    await writeNewState(newState);
  } catch (err) {
    process.stderr.write(
      `Aviso: no se pudo escribir el estado en ${STATE_PATH} — ${err.message}\n`
    );
  }

  if (flags.json) {
    process.stdout.write(JSON.stringify(records, null, 2) + "\n");
  } else {
    process.stdout.write(renderTable(records, prior, now) + "\n");
  }

  if (failed.length > 0) {
    const failedSyms = failed.map((r) => r.pair).join(", ");
    process.stderr.write(
      `Aviso: ${failed.length}/${records.length} pares fallaron: ${failedSyms}\n`
    );
  }
}

await main();
