#!/usr/bin/env node
// CLI del backtester local.
//
// Uso:
//   node scripts/backtest.js BTCUSDT [INTERVAL] [flags]
//
// Flags:
//   --from <ISO>           inicio de ventana (default: hace 6 meses)
//   --to <ISO>             fin de ventana (default: ahora)
//   --strategy <name>      estrategia (default: utBotOnly)
//   --slippage-bps <N>     slippage en bps (default: 5)
//   --initial-capital <N>  capital inicial USDT (default: 144)
//   --json                 imprimir result.json en stdout (suprime output humano)
//   --no-snapshot          no escribir klines.json (útil para CI/smoke)
//   --replay <runId>       releer snapshot existente y re-ejecutar idéntico
//   --help                 mostrar esta ayuda
//
// Estrategias disponibles V1: utBotOnly (baseline). El resto vendrá con la
// change `confluence-engine`.
//
// Exit codes:
//   0 OK
//   1 args inválidos
//   2 runtime / red / FS
//
// ESM puro.

import { mkdir, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fetchKlines } from "./lib/klines.js";
import { runBacktest } from "./lib/backtest/engine.js";
import { computeMetrics } from "./lib/backtest/metrics.js";
import { writeReport } from "./lib/backtest/report.js";

const KNOWN_FLAGS = new Set([
  "from",
  "to",
  "strategy",
  "slippage-bps",
  "initial-capital",
  "json",
  "no-snapshot",
  "replay",
  "help",
  "h",
]);

const KNOWN_STRATEGIES = ["utBotOnly"];

function printUsage(stream = process.stderr) {
  const lines = [
    "Uso: node scripts/backtest.js SYMBOL [INTERVAL] [flags]",
    "",
    "Ejemplos:",
    "  node scripts/backtest.js BTCUSDT",
    "  node scripts/backtest.js ETHUSDT 1h --to 2026-04-30T00:00:00Z",
    "  node scripts/backtest.js BTCUSDT --replay 2026-05-01T12-00-00Z",
    "",
    "Flags:",
    "  --from <ISO>           inicio de ventana (default: hace 6 meses)",
    "  --to <ISO>             fin de ventana (default: ahora)",
    "  --strategy <name>      estrategia (default: utBotOnly)",
    "  --slippage-bps <N>     slippage en bps (default: 5)",
    "  --initial-capital <N>  capital inicial USDT (default: 144)",
    "  --json                 imprimir result.json en stdout",
    "  --no-snapshot          no escribir klines.json",
    "  --replay <runId>       releer snapshot existente y re-ejecutar",
    "  --help                 mostrar esta ayuda",
    "",
    "Aviso: utBotOnly es un baseline mínimo. El gate de testnet (win rate > 55%, R:R > 1:2)",
    "se aplica al backtest de `confluence-engine`, no a este.",
  ];
  stream.write(lines.join("\n") + "\n");
}

function parseArgs(argv) {
  const flags = {};
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const name = a.slice(2);
      if (!KNOWN_FLAGS.has(name)) {
        return { error: `Flag desconocido: --${name}` };
      }
      const next = argv[i + 1];
      if (
        name === "json" ||
        name === "no-snapshot" ||
        name === "help" ||
        name === "h"
      ) {
        flags[name] = true;
      } else if (!next || next.startsWith("--")) {
        return { error: `Flag --${name} requiere un valor` };
      } else {
        flags[name] = next;
        i++;
      }
    } else if (a.startsWith("-") && a.length > 1) {
      // -h shorthand
      if (a === "-h") {
        flags.help = true;
      } else {
        return { error: `Flag desconocido: ${a}` };
      }
    } else {
      pos.push(a);
    }
  }
  return { pos, flags };
}

function parseIntervalMs(interval) {
  const m = interval.match(/^(\d+)([mhdwM])$/);
  if (!m) throw new Error(`Intervalo inválido: ${interval}`);
  const n = parseInt(m[1], 10);
  const unit = m[2];
  switch (unit) {
    case "m":
      return n * 60 * 1000;
    case "h":
      return n * 3600 * 1000;
    case "d":
      return n * 86400 * 1000;
    case "w":
      return n * 7 * 86400 * 1000;
    case "M":
      return n * 30 * 86400 * 1000;
    default:
      throw new Error(`Unidad de intervalo desconocida: ${unit}`);
  }
}

function buildRunId() {
  // ISO timestamp UTC, FS-safe (sin `:` ni `.`).
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19) + "Z";
}

async function loadStrategy(name) {
  if (!KNOWN_STRATEGIES.includes(name)) {
    throw new Error(
      `Estrategia desconocida: ${name}. Disponibles: ${KNOWN_STRATEGIES.join(", ")}`,
    );
  }
  const mod = await import(`./lib/backtest/strategies/${name}.js`);
  // El archivo exporta { utBotOnly } (named) y default.
  const strat = mod[name] ?? mod.default;
  if (!strat || typeof strat.onBar !== "function") {
    throw new Error(
      `Estrategia ${name} no exporta { name, onBar } correctamente`,
    );
  }
  return strat;
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.error) {
    process.stderr.write(`Error: ${parsed.error}\n\n`);
    printUsage();
    process.exit(1);
  }
  const { pos, flags } = parsed;

  if (flags.help || flags.h) {
    printUsage(process.stdout);
    process.exit(0);
  }

  // Replay mode no requiere SYMBOL; fetch mode sí.
  if (!flags.replay && pos.length === 0) {
    process.stderr.write("Error: SYMBOL es obligatorio (o usar --replay).\n\n");
    printUsage();
    process.exit(1);
  }

  const strategyName = flags.strategy ?? "utBotOnly";
  let strategy;
  try {
    strategy = await loadStrategy(strategyName);
  } catch (e) {
    process.stderr.write(`Error: ${e.message}\n`);
    process.exit(1);
  }

  const slippageBps = parseInt(flags["slippage-bps"] ?? "5", 10);
  const initialCapital = parseFloat(flags["initial-capital"] ?? "144");
  if (!Number.isFinite(slippageBps) || slippageBps < 0) {
    process.stderr.write("Error: --slippage-bps debe ser un número >= 0.\n");
    process.exit(1);
  }
  if (!Number.isFinite(initialCapital) || initialCapital <= 0) {
    process.stderr.write("Error: --initial-capital debe ser un número > 0.\n");
    process.exit(1);
  }

  let symbol, interval, klines, baseParams;

  if (flags.replay) {
    const runDir = path.join("analysis", "backtests", String(flags.replay));
    const klinesPath = path.join(runDir, "klines.json");
    if (!existsSync(klinesPath)) {
      process.stderr.write(
        `Error: no se encontró snapshot en ${klinesPath}\n`,
      );
      process.exit(2);
    }
    let snapshot;
    try {
      snapshot = JSON.parse(await readFile(klinesPath, "utf-8"));
    } catch (e) {
      process.stderr.write(`Error leyendo snapshot: ${e.message}\n`);
      process.exit(2);
    }
    klines = snapshot.klines;
    symbol = snapshot.symbol;
    interval = snapshot.interval;
    baseParams = {
      symbol,
      interval,
      from: snapshot.params?.from ?? null,
      to: snapshot.params?.to ?? null,
      replayedFrom: String(flags.replay),
    };
  } else {
    symbol = pos[0];
    interval = pos[1] ?? "1h";

    let toMs;
    if (flags.to) {
      const parsedTo = Date.parse(flags.to);
      if (!Number.isFinite(parsedTo)) {
        process.stderr.write(`Error: --to no es ISO válido: ${flags.to}\n`);
        process.exit(1);
      }
      toMs = parsedTo;
    } else {
      toMs = Date.now();
    }

    const sixMonthsMs = 6 * 30 * 24 * 3600 * 1000;
    let fromMs;
    if (flags.from) {
      const parsedFrom = Date.parse(flags.from);
      if (!Number.isFinite(parsedFrom)) {
        process.stderr.write(`Error: --from no es ISO válido: ${flags.from}\n`);
        process.exit(1);
      }
      fromMs = parsedFrom;
    } else {
      fromMs = toMs - sixMonthsMs;
    }
    if (fromMs >= toMs) {
      process.stderr.write("Error: --from debe ser anterior a --to.\n");
      process.exit(1);
    }

    let intervalMs;
    try {
      intervalMs = parseIntervalMs(interval);
    } catch (e) {
      process.stderr.write(`Error: ${e.message}\n`);
      process.exit(1);
    }
    const limit = Math.ceil((toMs - fromMs) / intervalMs) + 50; // buffer

    try {
      // Bypass cache de loadKlinesCached: queremos el rango exacto, no una página.
      // fetchKlines pagina hacia atrás desde toMs hasta cubrir limit bars.
      klines = await fetchKlines(symbol, interval, { limit, endTime: toMs });
    } catch (e) {
      process.stderr.write(`Error obteniendo klines: ${e.message}\n`);
      process.exit(2);
    }

    // Filtrar a la ventana exacta.
    klines = klines.filter(
      (k) => k.openTime >= fromMs && k.openTime <= toMs,
    );

    baseParams = { symbol, interval, from: fromMs, to: toMs };
  }

  if (!Array.isArray(klines) || klines.length < 50) {
    process.stderr.write(
      `Error: velas insuficientes (${klines?.length ?? 0}, mínimo razonable: 50). Revisá --from/--to.\n`,
    );
    process.exit(2);
  }

  const fullParams = {
    ...baseParams,
    strategy: strategyName,
    slippageBps,
    initialCapital,
    barsCount: klines.length,
    snapshotKlines: !flags["no-snapshot"] && !flags.replay,
  };

  // Run
  let result;
  try {
    result = await runBacktest({
      klines,
      strategy,
      options: {
        slippageBps,
        initialCapital,
        utAtr: 10,
        utKey: 2,
        symbol,
      },
    });
  } catch (e) {
    process.stderr.write(`Error ejecutando backtest: ${e.message}\n`);
    if (process.env.DEBUG) process.stderr.write(`${e.stack}\n`);
    process.exit(2);
  }

  const metrics = computeMetrics(result.trades, initialCapital);

  const runId = flags.replay ? String(flags.replay) : buildRunId();
  const outDir = path.join("analysis", "backtests", runId);

  try {
    await mkdir(outDir, { recursive: true });
    await writeReport({
      runId,
      trades: result.trades,
      metrics,
      equityCurve: result.equityCurve,
      params: fullParams,
      outDir,
    });

    if (!flags["no-snapshot"] && !flags.replay) {
      await writeFile(
        path.join(outDir, "klines.json"),
        JSON.stringify(
          { symbol, interval, params: fullParams, klines },
          null,
          2,
        ),
      );
    }
  } catch (e) {
    process.stderr.write(`Error escribiendo reporte: ${e.message}\n`);
    process.exit(2);
  }

  if (flags.json) {
    // Volcar el result.json al stdout.
    const payload = {
      runId,
      params: fullParams,
      metrics,
      tradesCount: result.trades.length,
      outDir,
    };
    process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
  } else {
    const wr =
      metrics.winRate != null ? (metrics.winRate * 100).toFixed(1) + "%" : "n/d";
    const pnl = metrics.totalPnL.toFixed(2);
    const dd = (metrics.maxDrawdown * 100).toFixed(1) + "%";
    process.stdout.write(
      [
        "Backtest completado.",
        `Run ID: ${runId}`,
        `Output: ${path.join(outDir, "report.md")}`,
        `Trades: ${metrics.totalTrades} | Win rate: ${wr} | PnL: $${pnl} | Max drawdown: ${dd}`,
      ].join("\n") + "\n",
    );
  }
  process.exit(0);
}

main().catch((e) => {
  process.stderr.write(`Error inesperado: ${e.message}\n`);
  if (process.env.DEBUG) process.stderr.write(`${e.stack}\n`);
  process.exit(2);
});
