// Telegram notifier para scan-confluence (y futuros senders).
//
// Lee TELEGRAM_BOT_TOKEN y TELEGRAM_CHAT_ID de process.env. Si faltan, devuelve
// graceful { ok: false, error } en lugar de throw — el scanner sigue corriendo
// aunque no haya canal configurado.
//
// HTML mode: simpler escaping (solo <, >, &) que MarkdownV2.
//
// ESM puro, sin dependencias externas. Usa fetch nativo de Node 20+.

const TELEGRAM_API = "https://api.telegram.org";
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Escapa los 3 caracteres reservados de Telegram HTML mode.
 * Necesario solo en texto plano fuera de tags <b>/<code>/<pre>/etc.
 * Pasar texto ya HTML-formateado funciona si los tags están bien balanceados.
 *
 * @param {string} s
 * @returns {string}
 */
export function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * POST a la API de Telegram /sendMessage.
 *
 * @param {string} text Mensaje (puede contener HTML tags válidos: <b>, <i>, <code>, <pre>, <a>).
 * @param {{
 *   parseMode?: 'HTML'|'MarkdownV2',
 *   disablePreview?: boolean,
 *   timeoutMs?: number,
 *   token?: string,
 *   chatId?: string,
 * }} [options]
 * @returns {Promise<{ ok: boolean, error?: string, response?: any }>}
 */
export async function sendTelegram(text, options = {}) {
  const {
    parseMode = "HTML",
    disablePreview = true,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    token = process.env.TELEGRAM_BOT_TOKEN,
    chatId = process.env.TELEGRAM_CHAT_ID,
  } = options;

  if (!token || !chatId) {
    return {
      ok: false,
      error: "TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID missing in .env",
    };
  }

  const url = `${TELEGRAM_API}/bot${token}/sendMessage`;
  const body = {
    chat_id: chatId,
    text,
    parse_mode: parseMode,
    disable_web_page_preview: disablePreview,
  };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    let json = null;
    try {
      json = await resp.json();
    } catch {
      // ignorar — respuesta no JSON
    }

    if (!resp.ok || (json && json.ok === false)) {
      const desc =
        (json && (json.description || json.error_code)) ||
        `HTTP ${resp.status}`;
      return { ok: false, error: `Telegram API error: ${desc}`, response: json };
    }

    return { ok: true, response: json };
  } catch (err) {
    clearTimeout(timeoutId);
    if (err && (err.name === "AbortError" || err.name === "TimeoutError")) {
      return { ok: false, error: "Telegram request timeout (10s)" };
    }
    const cause = err && err.message ? err.message : String(err);
    return { ok: false, error: `Telegram network error: ${cause}` };
  }
}

export default sendTelegram;
