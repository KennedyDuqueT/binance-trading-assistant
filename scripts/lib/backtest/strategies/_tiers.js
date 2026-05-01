// Tier resolver para confluence-engine (V1a).
//
// Tabla cableada según PRD §5.3 (tamaño y apalancamiento por tier):
//   - T1 (BTC, ETH, SOL, XRP): $10 USDT, 7-10x
//   - T2 (BIO, AXL, VIRTUAL, TAO): $3 USDT, 4x
//   - T3 (DOGE, 1000BONK, WIF, PENGU): $2 USDT, 2.5x
//
// V1 elige el punto medio de cada rango del PRD. El sizing dinámico (ATR-scaled)
// queda para una change posterior (`confluence-engine-dynamic-sizing`).
//
// Decisión D15: fail-fast en símbolos desconocidos con hint en español. Si el
// operador escribe `BONKUSDT` recibe un mensaje sugiriendo `1000BONKUSDT` (los
// memecoins en Binance Futures usan ese prefijo por convención del exchange).
//
// ESM puro. Sin imports.

const TIERS = {
  // Tier 1 — majors
  BTCUSDT: { tier: 1, sizeUSDT: 10, leverage: 10 },
  ETHUSDT: { tier: 1, sizeUSDT: 10, leverage: 7 },
  SOLUSDT: { tier: 1, sizeUSDT: 10, leverage: 7 },
  XRPUSDT: { tier: 1, sizeUSDT: 10, leverage: 7 },
  // Tier 2 — narrative altcoins
  BIOUSDT: { tier: 2, sizeUSDT: 3, leverage: 4 },
  AXLUSDT: { tier: 2, sizeUSDT: 3, leverage: 4 },
  VIRTUALUSDT: { tier: 2, sizeUSDT: 3, leverage: 4 },
  TAOUSDT: { tier: 2, sizeUSDT: 3, leverage: 4 },
  // Tier 3 — memecoins
  DOGEUSDT: { tier: 3, sizeUSDT: 2, leverage: 2.5 },
  "1000BONKUSDT": { tier: 3, sizeUSDT: 2, leverage: 2.5 },
  WIFUSDT: { tier: 3, sizeUSDT: 2, leverage: 2.5 },
  PENGUUSDT: { tier: 3, sizeUSDT: 2, leverage: 2.5 },
};

/**
 * Resuelve tier y sizing para un símbolo.
 *
 * @param {string} symbol Par USDT-M (e.g., "BTCUSDT", "1000BONKUSDT").
 * @returns {{ tier: 1|2|3, sizeUSDT: number, leverage: number }}
 * @throws {Error} si el símbolo no está en la tabla.
 */
export function resolveTier(symbol) {
  const t = TIERS[symbol];
  if (!t) {
    // Hint específico para memecoins con prefijo 1000 (binance-symbol-policy).
    const isMemeMissingPrefix = /^(BONK|PEPE|SHIB|FLOKI)USDT$/i.test(
      String(symbol),
    );
    const hint = isMemeMissingPrefix
      ? ` ¿Querías 1000${symbol}? (Binance Futures lista memecoins con prefijo 1000).`
      : "";
    throw new Error(
      `Símbolo desconocido para tier sizing: ${symbol}.${hint} ` +
        `Tiers definidos: ${Object.keys(TIERS).join(", ")}.`,
    );
  }
  return { ...t };
}

export const KNOWN_SYMBOLS = Object.keys(TIERS);

export default resolveTier;
