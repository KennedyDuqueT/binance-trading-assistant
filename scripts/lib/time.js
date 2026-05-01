// Helpers de tiempo compartidos.
// El operador opera y mira charts en TradingView con TZ UTC-5 (per engram
// operator-tv-config). Para que los reportes humanos del backtester sean
// directamente comparables con su pantalla, formateamos los tiempos en UTC-5.
//
// ESM puro. Sin imports externos.

export const OPERATOR_TZ_OFFSET_HOURS = -5;

/**
 * Renderiza un timestamp (ms epoch) como `YYYY-MM-DD HH:mm` en UTC-5.
 * Implementación sin dependencias: shifteamos el ms por el offset y leemos
 * los componentes UTC del Date resultante (así evitamos el bias de TZ del runtime).
 *
 * @param {number} ms epoch en milisegundos
 * @returns {string}
 */
export function fmtOperatorTime(ms) {
  const offsetMs = OPERATOR_TZ_OFFSET_HOURS * 3600 * 1000;
  const shifted = new Date(ms + offsetMs);
  // Usamos getters UTC sobre el Date shifted -> componentes "as if" en UTC-5.
  const yyyy = shifted.getUTCFullYear();
  const mm = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(shifted.getUTCDate()).padStart(2, "0");
  const hh = String(shifted.getUTCHours()).padStart(2, "0");
  const mi = String(shifted.getUTCMinutes()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}`;
}

/**
 * Igual que fmtOperatorTime pero con sufijo de zona horaria explícito.
 * @param {number} ms
 * @returns {string}
 */
export function fmtOperatorTimeWithTZ(ms) {
  const sign = OPERATOR_TZ_OFFSET_HOURS >= 0 ? "+" : "";
  return `${fmtOperatorTime(ms)} UTC${sign}${OPERATOR_TZ_OFFSET_HOURS}`;
}
