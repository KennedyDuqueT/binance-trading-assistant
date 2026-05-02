# Trade Log

Cada trade ejecutado (incluyendo testnet) se documenta aquí con el formato siguiente. Después de 30 trades documentados: evaluar win rate, profit factor, max drawdown, R:R promedio realizado vs planeado, y adherencia al sistema (cuántos trades cumplieron 3 de 4 confluencias antes de entrar).

---

## Formato

Encabezado de bloque: `YYYY-MM-DD HH:MM — PAR — LONG/SHORT`

Campos obligatorios (un campo por línea, label al inicio):

Setup: [confluencias verificadas: UT Bot, LuxAlgo S&R, volumen, contexto BTC]
Entrada: $X.XX
Stop: $X.XX (riesgo: $Y, equivalente al Z% del capital)
TP1: $X.XX (50% del tamaño)
TP2: $X.XX (30% del tamaño)
TP3: $X.XX (20% trailing a breakeven)
Tamaño: $Z USDT con apalancamiento Nx (notional efectivo: $Z * N)
Resultado: [pendiente | +X USDT | −X USDT | breakeven]
Lección: [qué aprendí — qué hice bien, qué hice mal, qué cambiar]

---

## Trades

2026-05-02 04:30 — LABUSDT — LONG

Setup: 2.5/4 confluencias (UT Bot 1H+4H LONG OK, volumen 7.8x promedio OK, LuxAlgo S&R PARCIAL — break "B" hace 9 velas a $0.82 confirmado pero entry actual $1.7525 NO en confluencia con el break, contexto BTC NO alineado — BTC long pero extendido y frágil). Mínimo del sistema es 3/4 — entrada NO cumple regla. Deviations: (1) LAB off-watchlist; (2) leverage 10x excede tier T3 (cap 2-3x para memecoins/altcoins desconocidas); (3) post-pump chase tras +155% 24h, mejor entrada técnica fue hace 9 velas a $0.82; (4) funding extremo 0.339%/8h (~371% APR, ~1%/día notional bleed). Entrada contra recomendación previa DO_NOT_ENTER del orchestrator.
Entrada: $1.7525
Stop: $1.68 (riesgo: $1.59 USDT, equivalente al 1.1% del capital $144)
TP1: $1.82 (50% del tamaño, +$0.74 esperado)
TP2: $1.95 (30% del tamaño, +$1.30 esperado)
TP3: $2.00 o trailing post-TP1 a breakeven, exit en UT Bot 1H "Sell" (20% del tamaño)
Tamaño: $3.83 USDT con apalancamiento 10x (notional efectivo: $38.30, liquidación ~$1.58)
Detalle de salidas:
- TP1 (50%): 11 LAB @ $1.8099 → +$0.6314 (00:01:44)
- TP2 (27%): 6 LAB @ $1.9484 → +$1.1754 (00:15:33)
- Residual (23%): 5 LAB @ $1.7624 (SL deliberadamente seteado en $1.7625, no en BE $1.7525, para cubrir comisiones round-trip — fill con 1 tick slippage del trigger) → +$0.0495 (00:16:46)
- Comisiones totales: ~$0.035 (entrada + 3 salidas)
- Funding cost: ~$0.01
Resultado: +$1.81 NET (+47% margin, +1.26% capital) en <60 min
Lección: El outcome positivo NO valida romper 3 de 4 reglas — la entrada fue lucky timing, el edge real estuvo en el post-entry management (ladder TP1/TP2/residual + move a BE post-TP1 + órdenes pre-puestas que ejecutaron en 73 segundos cuando el chart hizo el wick a $1.5831). El round number $2.00 actuó como magnet+reject perfecto (high $1.9801, dump -20% en 15 min): TPs en niveles no-round (-$0.05 del round) capturaron el move ANTES del rechazo. Si hubiera cedido al FOMO 2.0 y subido TP2 a $2.00, NUNCA fillaba → BE en 50% restante → solo $0.74 vs $1.81 NET actual (factor 2.5x del profit final perdido por instinto). Order management avanzado en el residual: Operator seteó SL en $1.7625 (NO en BE $1.7525), añadiendo buffer ~$0.01/LAB para cubrir comisiones round-trip. Cuando el wick disparó el stop, el sistema cerró exactamente como diseñado: residual sale en positivo neto incluso después de fees, no en BE-pelado. Esto es order management avanzado: el operator NO confió en BE como red de seguridad, ajustó arriba para hacer matemáticamente imposible perder en el residual. Lesson transferable: cualquier futuro "BE stop" debe ser BE + fees + algún buffer, no BE crudo. Es el tipo de detalle que separa traders que sobreviven de los que no. Meta-observación al orchestrator: El operator improved on la recomendación del orchestrator (que era BE $1.7525); el orchestrator NO mencionó factor comisiones en el SL move. Es feedback útil para el orchestrator: futuras recomendaciones de BE post-TP1 deben incluir buffer por comisiones. Lecciones operacionales: (1) sistema > análisis en post-entry, (2) TPs en niveles no-round capturan rechazos previsibles, (3) órdenes pre-puestas salvan trades que mirando chart no ejecutarías a tiempo, (4) outcome ≠ proceso — la deviation NO queda validada y no debe repetirse, (5) BE stops deben incluir buffer de comisiones — nunca BE crudo.
