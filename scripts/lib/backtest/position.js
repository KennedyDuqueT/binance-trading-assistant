// Position class para el backtester. Representa UNA posición abierta a la vez (V1
// long-only). Encapsula:
//   - estado (side, entryTime, entryPrice, stopPrice, tpPrice, sizeUSDT, leverage)
//   - aplicación de bar para resolver fills (stop / TP / open)
//   - matemática de PnL y R
//
// Reglas (decisiones del design):
//   - Stop-first: si en el mismo bar low ≤ stop AND high ≥ tp, llena el STOP.
//   - Slippage en bps: en exit, se sustrae bps en la dirección desfavorable.
//   - PnL = sizeUSDT * leverage * (exit - entry) / entry * sideMul
//   - R    = (exit - entry) / |entry - stop| * sideMul
//   - sideMul = +1 long, -1 short. V1: solo long, pero la matemática es simétrica.
//
// ESM puro.

/**
 * Clase Position. Construir con argumentos nombrados; entryPrice ya debe incluir
 * el slippage de entrada (lo aplica el engine al abrir).
 */
export class Position {
  /**
   * @param {{
   *   side: 'long' | 'short',
   *   entryTime: number,
   *   entryPrice: number,
   *   stopPrice: number,
   *   tpPrice: number | null,
   *   sizeUSDT: number,
   *   leverage: number,
   *   entryBarIdx?: number
   * }} args
   */
  constructor({
    side,
    entryTime,
    entryPrice,
    stopPrice,
    tpPrice,
    sizeUSDT,
    leverage,
    entryBarIdx = null,
  }) {
    this.side = side;
    this.entryTime = entryTime;
    this.entryPrice = entryPrice;
    this.stopPrice = stopPrice;
    this.tpPrice = tpPrice ?? null;
    this.sizeUSDT = sizeUSDT;
    this.leverage = leverage;
    this.entryBarIdx = entryBarIdx;
    this.status = "open";
  }

  /**
   * Calcula PnL en USDT al precio dado.
   * @param {number} exitPrice
   * @returns {number}
   */
  pnlAt(exitPrice) {
    const sideMul = this.side === "long" ? 1 : -1;
    return (
      (this.sizeUSDT * this.leverage * (exitPrice - this.entryPrice)) /
        this.entryPrice *
      sideMul
    );
  }

  /**
   * Calcula múltiplo R al precio dado.
   * @param {number} exitPrice
   * @returns {number}
   */
  rAt(exitPrice) {
    const sideMul = this.side === "long" ? 1 : -1;
    const denom = Math.abs(this.entryPrice - this.stopPrice);
    if (denom === 0) return 0;
    return ((exitPrice - this.entryPrice) / denom) * sideMul;
  }

  /**
   * Aplica un bar a la posición. Resuelve stop/tp con regla stop-first.
   * Slippage se aplica al exitPrice en dirección desfavorable.
   *
   * @param {{open:number,high:number,low:number,close:number,openTime:number}} bar
   * @param {number} slippageBps
   * @returns {{
   *   status: 'stopped' | 'tp_hit' | 'open',
   *   exitTime?: number,
   *   exitPrice?: number,
   *   pnlUSDT?: number,
   *   R?: number
   * }}
   */
  apply(bar, slippageBps) {
    const slip = (slippageBps ?? 0) / 10000;
    const { stopPrice, tpPrice, side } = this;

    let stopHit = false;
    let tpHit = false;

    if (side === "long") {
      stopHit = bar.low <= stopPrice;
      tpHit = tpPrice != null && bar.high >= tpPrice;
    } else {
      // short
      stopHit = bar.high >= stopPrice;
      tpHit = tpPrice != null && bar.low <= tpPrice;
    }

    if (!stopHit && !tpHit) {
      return { status: "open" };
    }

    // Stop-first si ambos entran en el bar.
    let exitPrice;
    let status;
    if (stopHit) {
      // Slippage desfavorable en el exit:
      //   long stop: paga abajo del stop -> exitPrice = stopPrice * (1 - slip)
      //   short stop: paga arriba del stop -> exitPrice = stopPrice * (1 + slip)
      exitPrice =
        side === "long" ? stopPrice * (1 - slip) : stopPrice * (1 + slip);
      status = "stopped";
    } else {
      // tpHit only
      // Slippage desfavorable en el exit:
      //   long tp: cobra abajo del tp -> exitPrice = tpPrice * (1 - slip)
      //   short tp: cobra arriba del tp -> exitPrice = tpPrice * (1 + slip)
      exitPrice =
        side === "long" ? tpPrice * (1 - slip) : tpPrice * (1 + slip);
      status = "tp_hit";
    }

    const pnlUSDT = this.pnlAt(exitPrice);
    const R = this.rAt(exitPrice);
    this.status = status;

    return {
      status,
      exitTime: bar.openTime,
      exitPrice,
      pnlUSDT,
      R,
    };
  }
}

/**
 * Helper sin estado para crear una Position. Disponible además de la clase
 * para quien prefiera estilo funcional.
 */
export function createPosition(args) {
  return new Position(args);
}
