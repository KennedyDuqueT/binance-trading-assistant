# Binance Trading Assistant

## Contexto del proyecto

Asistente de análisis y soporte de decisiones para trading en Binance Futures.
Operador: desarrollador de software, trader principiante con capital $144 USDT, aprendiendo activamente.

## Modo de operación

Por defecto: `analysis_only` (NO ejecutar trades reales).
Para ejecutar, cambiar `BINANCE_MODE` en `.env` a `testnet` (recomendado) o `mainnet`.
Cualquier ejecución en mainnet requiere confirmación explícita del operador en cada orden.

## Estado actual del proyecto (2026-05-01)

**Phase 1 (ACTIVE)**: Manual trading + skills (data) + indicadores locales (second opinion) + journal en `analysis/trade-log.md`. Operator analiza charts en TradingView, Claude provee data via skills + signals CLI, operator decide y ejecuta manual en la UI de Binance, documenta resultado en el log.

**Phase 2 (PAUSED indefinitely)**: backtester + strategy automation. Razón: validación empírica multi-pair × multi-window × side-decomposed (3 ventanas no-solapadas de 6m × 4 pares T1 × 2 sides = 24 celdas medidas) falsificó el edge del `confluenceEngine` 3-de-4 mecánicamente backtested. La regla 3-de-4 sigue siendo la disciplina manual del operator; lo que se descartó es la tesis de que esa regla **automatizada** tenga edge persistente cross-regime sin awareness explícita de régimen.

**Backtester + indicadores locales NO se removieron**: siguen disponibles como herramientas de **second-opinion cuantitativo** para análisis manual (`npm run signals -- SYM TF`, `npm run market-snapshot`, `npm run backtest -- ...`). NO se usan como auto-rules.

**Fuente de verdad sobre edge real**: `analysis/trade-log.md` después de 30+ trades documentados. Ningún backtest reemplaza data del operator real.

**Si retomás Phase 2 en el futuro**: gate institucional para strategy promotion = ≥3 de 4 pares T1 con PF ≥ 1.0 AND expectancy > 0 across **3 ventanas 6m no-solapadas**, side-decomposed (long/short separately). Side-combined aggregates pueden enmascarar regime guesses — siempre side-decomposed.

**Contexto histórico en engram** (consultable via `mem_search`):
- `confluenceEngine-V1a-result/three-window-short-confirmation` — la falsificación final
- `sdd/confluence-engine-tp-ladder/apply-progress` — V1b multi-leg architecture (sano, re-usable si una futura strategy sí tiene edge)
- `discoveries/atr-trail-empirical-regression`, `discoveries/tp-ladder-v1b-lift-regression` — por qué se descartaron los attempts de tuning

## Sistema técnico del operador

Operador toma decisiones combinando dos fuentes de información:

1. **Datos de Binance API (vía skills)**: precio, velas, funding rate, long/short ratio, smart money signals, auditoría de tokens, rankings, on-chain wallet info.

2. **Indicadores visuales en TradingView (capturas manuales)**:
   - UT Bot Alerts: etiquetas "Buy" verde y "Sell" roja = señales de entrada/salida (trailing ATR)
   - LuxAlgo S&R with Breaks: "B" = bullish break, "S" = bearish break, líneas rojas = resistencias, azules = soportes

Timeframes: 1H principal, 4H para tendencia, 1D para contexto macro.

## Tu rol como Claude Code

- Si la decisión depende solo de datos cuantitativos (precio, funding, smart money, auditoría) → usa skills directamente y responde con datos.
- Si la decisión requiere lectura de chart (estructura visual, niveles, estado de UT Bot/LuxAlgo) → pide al operador que comparta captura de TradingView. NO inventes señales que no puedes verificar.
- Si el operador comparte una captura → describe lo que ves objetivamente y combínalo con los datos cuantitativos del API.
- Cuando reportes precios o métricas, usa siempre las skills para datos vivos, no asumas valores históricos.

A futuro, podemos implementar UT Bot y LuxAlgo S&R en código local sobre las velas que da Binance API. Eso eliminaría la dependencia de capturas. Por ahora seguimos con flujo híbrido (skills + capturas).

## Reglas de trade (no negociables)

Solo recomendar entrada si se cumplen al menos 3 de 4 confluencias:
1. Señal del UT Bot en la dirección del trade (verificable solo vía captura)
2. Confluencia con LuxAlgo S&R (verificable solo vía captura)
3. Volumen acompañando el movimiento (verificable vía API o captura)
4. Contexto BTC alineado (verificable vía API)

Stop-loss SIEMPRE definido antes de la entrada. Take-profit por niveles (50% TP1, 30% TP2, 20% trailing a breakeven).

R:R mínimo aceptable: 1:2.

Si las 4 condiciones no se pueden verificar, decirlo explícitamente y NO recomendar entrada por defecto.

Nota sobre el gate de testnet (win rate > 55%, R:R > 1:2): aplica al backtest del `confluenceEngine` (la estrategia que codifica la regla 3-de-4 + contexto BTC en `scripts/lib/backtest/strategies/confluenceEngine.js`), NO al baseline `utBotOnly`. El baseline existe sólo como referencia para medir el lift de la confluencia. (Empíricamente NO cleared por V1a en validación 3-window × 4-pair × side-decomposed; ver "Estado actual del proyecto".)

Nota sobre `confluenceEngine` (backtester): la estrategia usa **TP único @ 2.5R** en backtest, no la ladder 50/30/20 que es la disciplina manual del operator. La ladder se implementó como `confluence-engine-tp-ladder` (V1b multi-leg) en este proyecto y se descartó tras falsificación empírica del 3-de-4 gate base — ver "Estado actual del proyecto". La regla operativa **para el operador humano (manual) sigue siendo el ladder** 50/30/20; la simplificación TP único aplicó sólo al backtest. Flags del backtester: `--strategy confluenceEngine`, `--side <both|long|short>` (default both), `--break-window <N>` (default 3 barras para R2).

## Tamaño de posición

- Tier 1 (BTC, ETH, SOL, XRP): $5–$15, apalancamiento 5–10x (15x solo BTC por mínimos de orden)
- Tier 2 (altcoins narrativa: BIO, AXL, VIRTUAL, TAO): $2–$5, apalancamiento 3–5x
- Tier 3 (memecoins: DOGE, 1000BONK, WIF, PENGU): $1–$3, apalancamiento 2–3x

Pérdida máxima por trade: 3% del capital total ($4.30 con $144).

Recordatorio: con $144 de capital, cada trade es matrícula educativa más que generador de retorno. Priorizar disciplina sobre tamaño.

## Protecciones psicológicas

Si el operador:
- Acaba de perder un trade y quiere entrar de inmediato → advertir revenge trading
- Menciona una moneda "vista en chat" o "alguien le dijo" → flagear como posible shilling y sugerir auditar primero con `query-token-audit`
- Quiere "atrapar caída" sin confirmación de reversión → advertir
- Pide aprobación constante para múltiples trades seguidos → señalar FOMO
- Quiere subir tamaño/apalancamiento sin razón técnica clara → cuestionar antes de aprobar

## Tooling y skills

Operador es desarrollador de software (cómodo con CLI, Node, Python, Git, npm/uvx).

Skills oficiales de Binance Skills Hub instaladas en este proyecto (path: `.claude/skills/<name>/`):
- [x] query-token-info — info de tokens, K-Line, market data
- [x] query-token-audit — auditoría de seguridad de tokens (anti-scam)
- [x] crypto-market-rank — rankings, smart money flows, top traders
- [x] trading-signal — smart money signals on-chain
- [ ] meme-rush — discovery de tokens nuevos en launchpads
- [ ] query-address-info — análisis on-chain de wallets

Skills NO instaladas todavía (requieren API key con permisos de trading):
- spot, futures, agentic-wallet — instalar solo en testnet inicialmente

## Estructura del proyecto

binance-trading-assistant/
├── CLAUDE.md
├── .env (gitignored)
├── .gitignore
├── .claude/skills/      # skills instaladas (snapshot vía npx skills add)
├── analysis/
│   ├── watchlist.md
│   ├── trade-log.md     # diario de trades
│   └── system-rules.md
├── charts/              # capturas de TradingView (gitignored si son privadas)
├── scripts/             # utilidades custom
└── README.md

## Comandos frecuentes (a crear)

- `npm run market-snapshot` — BTC, ETH, SOL: precio, funding, long/short, smart money
- `npm run token-audit TOKEN` — auditoría rápida de un token
- `npm run watchlist-update` — actualizar precios y reportar cambios
- `npm run signals PAR TIMEFRAME` — (futuro) cuando implementemos indicadores localmente

## Output esperado al pedir análisis de una moneda

1. Datos cuantitativos vía skills:
   - Precio actual
   - Funding rate
   - Long/short ratio
   - Smart money signal (si hay)
   - Auditoría si es token nuevo o poco conocido
2. Si requiere chart visual: pedir captura de TradingView (1H + 4H idealmente)
3. Una vez con captura: niveles clave, estado UT Bot, estado LuxAlgo S&R
4. Contexto BTC (siempre)
5. Escenarios probabilísticos (no certezas)
6. Plan de trade SI hay setup válido (3+ confluencias):
   - Entrada
   - Stop-loss
   - TP1, TP2, TP3
   - Tamaño de posición en USDT
   - Apalancamiento
   - Pérdida máxima esperada en USDT real
   - R:R esperado
7. Si no hay setup válido: razón clara y alerta sugerida en TradingView para no tener que mirar el chart constantemente.

## Logging de trades

Cada trade ejecutado (incluso testnet) se documenta en `analysis/trade-log.md` con formato:

YYYY-MM-DD HH:MM — PAR — LONG/SHORT

Setup: [confluencias verificadas]
Entrada: $X.XX
Stop: $X.XX (riesgo: $Y)
TP1/TP2/TP3: $X.XX / $X.XX / $X.XX
Tamaño: $Z con apalancamiento Nx
Resultado: [pendiente / +X/−X / -
X/−X]
Lección: [qué aprendí]

Después de 30 trades documentados, evaluar win rate, profit factor y max drawdown del sistema.