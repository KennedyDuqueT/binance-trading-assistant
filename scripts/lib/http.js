// Helper HTTP compartido para los scripts de utilidad.
// ESM, sin dependencias externas. Usa el `fetch` nativo de Node 20+.
//
// Exporta:
//   - fetchJson(url, opts)  -> JSON parseado o lanza Error con prefijo en español.
//   - withTimeout(ms)       -> AbortSignal con timeout listo para uso ad-hoc.
//
// Política de errores (decisión #3 del design):
//   - Timeout      -> Error("Tiempo de espera agotado: <url>")
//   - Red          -> Error("Error de red: <url> — <causa>")
//   - HTTP no-2xx  -> Error("HTTP <code>: <url> — <snippet del body>")

const DEFAULT_TIMEOUT_MS = 15_000;
const BODY_SNIPPET_MAX = 200;

export function withTimeout(ms = DEFAULT_TIMEOUT_MS) {
  // AbortSignal.timeout llega en Node 20.x estable. Wrap por consistencia.
  return AbortSignal.timeout(ms);
}

/**
 * Wrapper sobre fetch nativo. Devuelve JSON parseado.
 * @param {string} url
 * @param {{
 *   method?: string,
 *   body?: any,
 *   headers?: Record<string,string>,
 *   timeoutMs?: number,
 * }} [opts]
 */
export async function fetchJson(url, opts = {}) {
  const {
    method = "GET",
    body,
    headers = {},
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = opts;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  const init = {
    method,
    headers: { ...headers },
    signal: controller.signal,
  };

  if (body !== undefined) {
    if (typeof body === "string" || body instanceof URLSearchParams) {
      init.body = body;
    } else {
      init.body = JSON.stringify(body);
      if (!init.headers["Content-Type"] && !init.headers["content-type"]) {
        init.headers["Content-Type"] = "application/json";
      }
    }
  }

  let response;
  try {
    response = await fetch(url, init);
  } catch (err) {
    clearTimeout(timeoutId);
    // AbortError tiene name === "AbortError"; en Node 20 también puede ser DOMException.
    if (err && (err.name === "AbortError" || err.name === "TimeoutError")) {
      throw new Error(`Tiempo de espera agotado: ${url}`);
    }
    const cause = err && err.message ? err.message : String(err);
    throw new Error(`Error de red: ${url} — ${cause}`);
  }

  clearTimeout(timeoutId);

  if (!response.ok) {
    let snippet = "";
    try {
      const text = await response.text();
      snippet = text.slice(0, BODY_SNIPPET_MAX).replace(/\s+/g, " ").trim();
    } catch {
      // ignorar
    }
    throw new Error(`HTTP ${response.status}: ${url} — ${snippet}`);
  }

  try {
    return await response.json();
  } catch (err) {
    const cause = err && err.message ? err.message : String(err);
    throw new Error(`Error de red: ${url} — respuesta no es JSON válido (${cause})`);
  }
}
