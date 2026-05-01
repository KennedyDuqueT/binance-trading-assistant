// Fetcher de klines de Binance Futures (USDT-M).
// Endpoint: https://fapi.binance.com/fapi/v1/klines
// Documentación: https://binance-docs.github.io/apidocs/futures/en/#kline-candlestick-data
//
// ESM, sin dependencias externas. Reusa fetchJson de ./http.js.
//
// Exporta:
//   - fetchKlines(symbol, interval, { limit, endTime })
//   - loadKlinesCached(symbol, interval, { limit, endTime })
//
// Cache en disco (decisión D6): analysis/klines/{SYMBOL}-{INTERVAL}-{ISOZ}.json
// Paginación (decisión D7): cursor por endTime, dedupe por openTime, sort ascendente.

import { fetchJson } from "./http.js";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const BASE_URL = "https://fapi.binance.com";
const PATH = "/fapi/v1/klines";
const MAX_PER_CALL = 1500;
const CACHE_DIR = "analysis/klines";

/**
 * Una sola página del endpoint /fapi/v1/klines.
 * Mapea las filas de 12 elementos a objetos con campos numéricos.
 *
 * @param {string} symbol
 * @param {string} interval
 * @param {{ limit?: number, endTime?: number }} opts
 * @returns {Promise<Array<{openTime:number,open:number,high:number,low:number,close:number,volume:number,closeTime:number}>>}
 */
async function _fetchKlinesPage(symbol, interval, { limit = 500, endTime } = {}) {
  const params = new URLSearchParams({
    symbol,
    interval,
    limit: String(Math.min(limit, MAX_PER_CALL)),
  });
  if (endTime !== undefined) {
    params.set("endTime", String(endTime));
  }
  const url = `${BASE_URL}${PATH}?${params.toString()}`;
  const rows = await fetchJson(url);

  if (!Array.isArray(rows)) {
    throw new Error(`Respuesta inesperada de ${url}: no es un array`);
  }

  return rows.map((r) => ({
    openTime: Number(r[0]),
    open: Number(r[1]),
    high: Number(r[2]),
    low: Number(r[3]),
    close: Number(r[4]),
    volume: Number(r[5]),
    closeTime: Number(r[6]),
  }));
}

/**
 * Fetch público con paginación automática.
 * Para limit > 1500, itera hacia atrás usando endTime = klines[0].openTime - 1
 * y dedupea por openTime (decisión D7).
 *
 * @param {string} symbol
 * @param {string} interval
 * @param {{ limit?: number, endTime?: number }} [opts]
 */
export async function fetchKlines(symbol, interval, opts = {}) {
  const { limit = 500, endTime } = opts;

  if (limit <= MAX_PER_CALL) {
    return _fetchKlinesPage(symbol, interval, { limit, endTime });
  }

  // Paginación: empezamos desde endTime (o "ahora") y caminamos hacia atrás.
  const seen = new Map(); // openTime -> record
  let cursor = endTime;
  let remaining = limit;

  // Cap defensivo de iteraciones para evitar loop infinito si la API se porta raro.
  const maxIterations = Math.ceil(limit / MAX_PER_CALL) + 4;
  let iterations = 0;

  while (remaining > 0 && iterations < maxIterations) {
    iterations += 1;
    const pageLimit = Math.min(remaining + 50, MAX_PER_CALL); // overlap pequeño para dedupe
    const page = await _fetchKlinesPage(symbol, interval, {
      limit: pageLimit,
      endTime: cursor,
    });
    if (page.length === 0) break;

    for (const k of page) {
      seen.set(k.openTime, k);
    }

    // Próximo cursor: openTime más antiguo - 1ms.
    const oldest = page[0].openTime;
    if (cursor !== undefined && oldest >= cursor) {
      // No avanzamos — corte para evitar loop.
      break;
    }
    cursor = oldest - 1;
    remaining = limit - seen.size;
  }

  const all = Array.from(seen.values()).sort((a, b) => a.openTime - b.openTime);
  // Devolvemos los últimos `limit` para preservar la cola más reciente.
  return all.slice(-limit);
}

function _isoZ(ts) {
  return new Date(ts).toISOString();
}

function _cacheFilename(symbol, interval, endTime) {
  const isoZ = _isoZ(endTime ?? Date.now());
  // Sanitizar `:` para nombres de archivo cross-platform.
  const safe = isoZ.replace(/:/g, "-");
  return path.join(CACHE_DIR, `${symbol}-${interval}-${safe}.json`);
}

/**
 * Lee cache si existe; si no, fetchea y graba atómicamente (temp + rename).
 *
 * @param {string} symbol
 * @param {string} interval
 * @param {{ limit?: number, endTime?: number }} [opts]
 */
export async function loadKlinesCached(symbol, interval, opts = {}) {
  const { limit = 500, endTime } = opts;
  const file = _cacheFilename(symbol, interval, endTime);

  if (existsSync(file)) {
    const raw = await readFile(file, "utf-8");
    return JSON.parse(raw);
  }

  const data = await fetchKlines(symbol, interval, { limit, endTime });
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(data), "utf-8");
  await rename(tmp, file);
  return data;
}
