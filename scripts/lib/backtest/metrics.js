// Métricas puras sobre un array de trades cerrados.
//
// computeMetrics(trades, initialCapital) devuelve los 10 campos contractados
// por el spec + algunos extras útiles para el reporte.
//
// equityCurve(trades, initialCapital) devuelve la curva por trade:
//   [{ time, equity }, ...] partiendo de initialCapital.
// (La curva por bar la genera el engine; ésta es la versión por trade, simple.)
//
// Si trades.length === 0, devuelve shape estable con totalTrades === 0 y
// los demás campos como null o 0 según corresponda.
//
// ESM puro.

/**
 * @param {Array<{pnlUSDT:number,pnlPct?:number,R?:number,holdBars?:number,exitTime?:number}>} trades
 * @param {number} initialCapital
 */
export function computeMetrics(trades, initialCapital) {
  if (!Array.isArray(trades) || trades.length === 0) {
    return {
      totalTrades: 0,
      winRate: null,
      profitFactor: null,
      maxDrawdown: 0,
      expectancy: null,
      avgR: null,
      sharpeApprox: null,
      avgHoldBars: null,
      longestWinStreak: 0,
      longestLoseStreak: 0,
      totalPnL: 0,
      finalEquity: initialCapital,
    };
  }

  const wins = trades.filter((t) => t.pnlUSDT > 0);
  const losses = trades.filter((t) => t.pnlUSDT <= 0);
  const totalProfit = wins.reduce((s, t) => s + t.pnlUSDT, 0);
  const totalLoss = Math.abs(losses.reduce((s, t) => s + t.pnlUSDT, 0));
  const totalPnL = totalProfit - totalLoss;

  // Max drawdown sobre curva equity por trade.
  let equity = initialCapital;
  let peak = equity;
  let maxDD = 0;
  for (const t of trades) {
    equity += t.pnlUSDT;
    if (equity > peak) peak = equity;
    const dd = peak > 0 ? (peak - equity) / peak : 0;
    if (dd > maxDD) maxDD = dd;
  }

  // Distribución de R.
  const rs = trades
    .map((t) => t.R)
    .filter((r) => Number.isFinite(r));
  const avgR =
    rs.length > 0 ? rs.reduce((s, r) => s + r, 0) / rs.length : null;

  // Sharpe aproximado sobre pnlPct por trade (no anualizado).
  const rets = trades
    .map((t) => (Number.isFinite(t.pnlPct) ? t.pnlPct : (t.pnlUSDT / initialCapital) * 100))
    .filter((r) => Number.isFinite(r));
  let sharpeApprox = null;
  if (rets.length > 1) {
    const avgRet = rets.reduce((s, r) => s + r, 0) / rets.length;
    const variance =
      rets.reduce((s, r) => s + (r - avgRet) ** 2, 0) / rets.length;
    const stdRet = Math.sqrt(variance);
    sharpeApprox = stdRet > 0 ? avgRet / stdRet : null;
  }

  // Streaks.
  let curWin = 0,
    curLose = 0,
    longestWin = 0,
    longestLose = 0;
  for (const t of trades) {
    if (t.pnlUSDT > 0) {
      curWin++;
      curLose = 0;
      if (curWin > longestWin) longestWin = curWin;
    } else {
      curLose++;
      curWin = 0;
      if (curLose > longestLose) longestLose = curLose;
    }
  }

  const holdBarsValues = trades
    .map((t) => t.holdBars)
    .filter((h) => Number.isFinite(h));
  const avgHoldBars =
    holdBarsValues.length > 0
      ? holdBarsValues.reduce((s, h) => s + h, 0) / holdBarsValues.length
      : null;

  return {
    totalTrades: trades.length,
    winRate: wins.length / trades.length,
    profitFactor: totalLoss > 0 ? totalProfit / totalLoss : null,
    maxDrawdown: maxDD,
    expectancy: totalPnL / trades.length,
    avgR,
    sharpeApprox,
    avgHoldBars,
    longestWinStreak: longestWin,
    longestLoseStreak: longestLose,
    totalPnL,
    finalEquity: initialCapital + totalPnL,
  };
}

/**
 * Curva de equity POR TRADE (no por bar). Útil para validaciones de spec.
 * Empieza con initialCapital y agrega un punto por trade cerrado.
 *
 * @param {Array<{exitTime:number,pnlUSDT:number}>} trades
 * @param {number} initialCapital
 */
export function equityCurve(trades, initialCapital) {
  const out = [{ time: null, equity: initialCapital }];
  let eq = initialCapital;
  for (const t of trades) {
    eq += t.pnlUSDT;
    out.push({ time: t.exitTime ?? null, equity: eq });
  }
  return out;
}
