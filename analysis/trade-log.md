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

(sin entradas todavía — el primer trade se documenta aquí cuando se ejecute, idealmente en testnet)
