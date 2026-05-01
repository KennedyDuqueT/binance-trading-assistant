// Report writer para los resultados de un backtest.
//
// Produce 4 archivos en outDir (CLI también escribe klines.json para replay):
//   - report.md   : reporte humano en español, con caveat de baseline
//   - trades.csv  : todos los trades, encabezados en inglés (Excel/Sheets)
//   - equity.csv  : curva de equity por bar
//   - result.json : métricas + parámetros + trades estructurados
//
// Tiempos humanos en UTC-5 (operator's TradingView TZ) via lib/time.js.
//
// ESM puro.

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fmtOperatorTime, fmtOperatorTimeWithTZ } from "../time.js";

/**
 * @param {{
 *   runId:string,
 *   trades:Array<object>,
 *   metrics:object,
 *   equityCurve:Array<{time:number,equity:number}>,
 *   params:object,
 *   outDir:string
 * }} args
 */
export async function writeReport({
  runId,
  trades,
  metrics,
  equityCurve,
  params,
  outDir,
}) {
  await mkdir(outDir, { recursive: true });

  // result.json
  await writeFile(
    path.join(outDir, "result.json"),
    JSON.stringify(
      {
        runId,
        params,
        metrics,
        trades,
        equityCurveLength: equityCurve.length,
      },
      null,
      2,
    ),
  );

  // trades.csv (encabezados en inglés)
  const tradesCsv = renderTradesCsv(trades);
  await writeFile(path.join(outDir, "trades.csv"), tradesCsv);

  // equity.csv (per-bar)
  const equityCsv = renderEquityCsv(equityCurve);
  await writeFile(path.join(outDir, "equity.csv"), equityCsv);

  // report.md (español, baseline caveat)
  const md = renderMarkdown({ runId, trades, metrics, equityCurve, params });
  await writeFile(path.join(outDir, "report.md"), md);
}

function renderTradesCsv(trades) {
  const header =
    "side,entryTime,entryPrice,stopPrice,tpPrice,exitTime,exitPrice,exitReason,sizeUSDT,leverage,pnlUSDT,pnlPct,R,holdBars";
  const rows = trades.map((t) =>
    [
      t.side,
      new Date(t.entryTime).toISOString(),
      t.entryPrice,
      t.stopPrice,
      t.tpPrice ?? "",
      new Date(t.exitTime).toISOString(),
      t.exitPrice,
      t.exitReason,
      t.sizeUSDT,
      t.leverage,
      Number.isFinite(t.pnlUSDT) ? t.pnlUSDT.toFixed(6) : "",
      Number.isFinite(t.pnlPct) ? t.pnlPct.toFixed(6) : "",
      Number.isFinite(t.R) ? t.R.toFixed(6) : "",
      t.holdBars ?? "",
    ].join(","),
  );
  return [header, ...rows].join("\n") + "\n";
}

function renderEquityCsv(equityCurve) {
  const header = "time,equity";
  const rows = equityCurve.map(
    (p) => `${new Date(p.time).toISOString()},${p.equity.toFixed(6)}`,
  );
  return [header, ...rows].join("\n") + "\n";
}

function renderMarkdown({ runId, trades, metrics, equityCurve, params }) {
  const fmt = (n, d = 2) => (Number.isFinite(n) ? n.toFixed(d) : "n/d");
  const fmtPct = (n, d = 2) =>
    Number.isFinite(n) ? (n * 100).toFixed(d) + "%" : "n/d";

  const caveat = [
    "> **Aviso (baseline)**: este backtest corre la estrategia `" +
      params.strategy +
      "`, que es un baseline mínimo (solo señales UT Bot, sin filtro de",
    "> confluencia 3-de-4, sin contexto BTC, sin TP por niveles). El gate de promoción a testnet definido en PRD §11 (win rate > 55%, R:R > 1:2)",
    "> NO se evalúa contra este resultado — se evalúa contra el backtest del `confluence-engine` cuando esté implementado. Esto es la línea base para",
    "> medir cuánto suma la confluencia.",
  ].join("\n");

  const fillRule = [
    "> **Regla de fill (stop-first)**: si en el mismo bar el `[low, high]` contiene tanto el stop como un TP, el engine resuelve el STOP primero.",
    "> Es la lectura conservadora — preferimos sobre-estimar drawdown que sobre-estimar ganancia.",
  ].join("\n");

  const windowFrom = Number.isFinite(params.from)
    ? fmtOperatorTime(params.from)
    : "n/d";
  const windowTo = Number.isFinite(params.to)
    ? fmtOperatorTimeWithTZ(params.to)
    : "n/d";

  const last30 = trades.slice(-30);
  const tradesSection =
    last30.length === 0
      ? "_Sin trades en este run._"
      : [
          "| Side | Entrada | Salida | Razón | PnL ($) | R |",
          "|---|---|---|---|---|---|",
          ...last30.map(
            (t) =>
              `| ${t.side} | ${fmtOperatorTime(t.entryTime)} @ $${fmt(t.entryPrice, 4)} | ${fmtOperatorTime(t.exitTime)} @ $${fmt(t.exitPrice, 4)} | ${t.exitReason} | $${fmt(t.pnlUSDT, 4)} | ${fmt(t.R, 3)} |`,
          ),
        ].join("\n");

  const sparkline = asciiSparkline(equityCurve);
  const snapshotLine = params.snapshotKlines
    ? "- `klines.json` — snapshot de velas para `--replay`"
    : "";

  return `# Backtest report — ${runId}

${caveat}

${fillRule}

## Parámetros

- Símbolo: ${params.symbol ?? "n/d"}
- Intervalo: ${params.interval ?? "n/d"}
- Ventana: ${windowFrom} → ${windowTo}
- Estrategia: \`${params.strategy}\`
- Capital inicial: $${fmt(params.initialCapital, 2)}
- Slippage: ${params.slippageBps} bps
- Bars analizados: ${params.barsCount}

## Métricas

| Métrica | Valor |
|---|---|
| Trades totales | ${metrics.totalTrades} |
| Win rate | ${fmtPct(metrics.winRate)} |
| Profit factor | ${fmt(metrics.profitFactor, 3)} |
| Max drawdown | ${fmtPct(metrics.maxDrawdown)} |
| Expectancy / trade | $${fmt(metrics.expectancy, 4)} |
| R promedio | ${fmt(metrics.avgR, 3)} |
| Sharpe (aprox, por trade) | ${fmt(metrics.sharpeApprox, 3)} |
| Hold promedio | ${fmt(metrics.avgHoldBars, 1)} bars |
| Mejor racha ganadora | ${metrics.longestWinStreak} |
| Peor racha perdedora | ${metrics.longestLoseStreak} |
| PnL total | $${fmt(metrics.totalPnL, 2)} |
| Equity final | $${fmt(metrics.finalEquity, 2)} |

## Últimos 30 trades

${tradesSection}

## Equity curve (sparkline)

\`\`\`
${sparkline}
\`\`\`

## Archivos del run

- \`report.md\` — este archivo
- \`trades.csv\` — todos los trades
- \`equity.csv\` — curva de equity por bar
- \`result.json\` — métricas + parámetros + trades estructurados
${snapshotLine}
`;
}

function asciiSparkline(equityCurve, width = 60) {
  if (!equityCurve || equityCurve.length === 0) return "(sin datos)";
  const equities = equityCurve.map((p) => p.equity).filter((v) => Number.isFinite(v));
  if (equities.length === 0) return "(sin datos)";
  const min = Math.min(...equities);
  const max = Math.max(...equities);
  const range = max - min || 1;
  const chars = "▁▂▃▄▅▆▇█";
  const stride = Math.max(1, Math.floor(equities.length / width));
  let out = "";
  for (let i = 0; i < equities.length; i += stride) {
    const v = equities[i];
    const idx = Math.min(
      chars.length - 1,
      Math.floor(((v - min) / range) * (chars.length - 1)),
    );
    out += chars[idx];
  }
  return out || "(sin datos)";
}
