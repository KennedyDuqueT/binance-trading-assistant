# Reglas del Sistema (System Rules)

Versión condensada de las reglas de trading del operador. Este archivo es **autocontenido** y debe poder leerse en una pantalla antes de cada trade. No reemplaza CLAUDE.md ni PRD.md (son audiencias distintas: este es para el operador humano, no para el agente).

---

## Modo de operación

Por defecto: **`analysis_only`** (solo análisis, sin ejecución).

Para ejecutar trades:
- `BINANCE_MODE=testnet` — recomendado para los primeros 30 trades.
- `BINANCE_MODE=mainnet` — solo cuando el sistema esté validado, y con confirmación explícita del operador en cada orden.

---

## Confluencias mínimas: 3 de 4

NO se entra a un trade si no se cumplen al menos 3 de las 4 confluencias:

1. Señal **UT Bot Alerts** en la dirección del trade (etiqueta verde "Buy" o roja "Sell" en TradingView).
2. Confluencia con **LuxAlgo S&R with Breaks** (B = bullish break, S = bearish break, niveles tocando soporte/resistencia clave).
3. **Volumen** acompañando el movimiento (no entrar contra movimientos de volumen seco).
4. **Contexto BTC** alineado (no abrir long en altcoin si BTC está en breakdown, y viceversa).

Si solo se verifican 2 de 4 → NO entrar, esperar.

---

## Stop-loss obligatorio

- Stop-loss SIEMPRE definido **antes** de la entrada, NO después.
- Base técnica: invalidación del setup (debajo de soporte LuxAlgo + buffer ATR, o cambio de dirección UT Bot).
- Si no se puede definir un stop con base técnica clara → no entrar.

---

## Take-profit por niveles

Sale por escalera, no todo a la vez:
- **TP1 (50%)** del tamaño de posición — primer nivel técnico (resistencia inmediata).
- **TP2 (30%)** del tamaño — segundo nivel técnico.
- **TP3 (20%)** trailing a breakeven — dejar correr con stop movido al precio de entrada.

R:R mínimo aceptable para entrar: **1:2** (riesgo $1 para ganar $2).

---

## Tamaño y apalancamiento por tier

Capital actual: $144 USDT. Pérdida máxima por trade: **3% del capital** (~$4.30).

| Tier | Pares | Tamaño | Apalancamiento |
|---|---|---|---|
| **T1** | BTC, ETH, SOL, XRP | $5–$15 | 5–10x (15x solo BTC por mínimos de orden) |
| **T2** | Narrative altcoins (BIO, AXL, VIRTUAL, TAO) | $2–$5 | 3–5x |
| **T3** | Memecoins (DOGE, BONK, WIF, PENGU) | $1–$3 | 2–3x |

Si la pérdida proyectada al stop excede 3% del capital → reducir tamaño antes de entrar.

---

## Banderas psicológicas (parar y revisar)

Detener antes de pulsar "Confirm Order" si pasa cualquiera de estas:

- **Revenge trading**: acabo de perder un trade y quiero entrar otro inmediatamente para "recuperar".
- **FOMO**: pido aprobación para múltiples trades seguidos sin setup claro.
- **Falling knife**: quiero "atrapar la caída" sin confirmación de reversión.
- **Shilling**: alguien (chat, Twitter, amigo) me dijo de la moneda sin que yo haya auditado el token primero.
- **Leverage escalation**: quiero subir tamaño o apalancamiento sin razón técnica explícita (curva de ganancias o sentimiento, no es razón).

Cuando aparece una bandera → cerrar el chart 15 minutos. Si después sigue siendo buena entrada, lo seguirá siendo.

---

## Recordatorio

Con $144 de capital, cada trade es **matrícula educativa** más que generador de retorno. Priorizar disciplina sobre tamaño. El objetivo de los primeros 30 trades es construir el log y validar el sistema, no maximizar ganancia.
