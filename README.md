# Binance Trading Assistant

## Visión

Co-pilot disciplinado para Binance Futures. No es un bot autónomo, no es consejo financiero — es un asistente de análisis y soporte de decisiones para un operador humano.

## Setup

```bash
git clone https://github.com/KennedyDuqueT/binance-trading-assistant.git
cd binance-trading-assistant
cp .env.example .env   # editar con tus claves (Reading ON, Withdrawals OFF, IP whitelist)
node --version          # runtime requiere >=20
```

Nota: la instalación de skills requiere Node 22+ (one-shot, vía `npx skills add`). Las skills de Binance Skills Hub se snapshotean (con `--copy`) en `.claude/skills/<name>/SKILL.md`, donde Claude Code las descubre automáticamente.

## Modo de operación

Controlado por `BINANCE_MODE` en `.env`:

- **`analysis_only`** (default) — solo análisis, sin ejecución.
- **`testnet`** — ejecución contra Binance Testnet (dinero falso, recomendado).
- **`mainnet`** — ejecución contra cuenta real, requiere confirmación explícita por orden.

## Comandos

```bash
# Snapshot de mercado (BTC, ETH, SOL): precio, funding, long/short
npm run market-snapshot
npm run market-snapshot -- --json

# Auditar un token. Smart mode (resuelve por símbolo) o explícito.
npm run token-audit -- AXL
npm run token-audit -- BSC 0xabc...
npm run token-audit -- BTC --json

# Watchlist: precios actuales + %Δ vs última corrida
npm run watchlist-update
npm run watchlist-update -- --json

# Señales locales (UT Bot + LuxAlgo S&R sobre velas Binance)
npm run signals -- BTCUSDT 1h
npm run signals -- ETHUSDT 4h --json
npm run signals -- SOLUSDT 1h --ut-key 3 --lux-pivot 10 --lux-vol-pct 25
```

Nota: con `npm run`, los argumentos hacia el script requieren el separador `--` (p.ej. `npm run token-audit -- AXL`). Sin el `--`, npm consume las flags.

Las señales son una implementación local de UT Bot Alerts y LuxAlgo S&R with Breaks sobre las velas que devuelve Binance Futures. Compará siempre con TradingView para validar; si las labels Buy/Sell o B/S no aparecen en el mismo candle, ajustá los parámetros con `--ut-atr`, `--ut-key`, `--lux-pivot`, `--lux-vol-pct`. La cache de klines vive en `analysis/klines/` (gitignored) — para limpiar: `rm -rf analysis/klines/`.

LuxAlgo emite 4 categorías de break, idénticas a las del Pine oficial: `B` y `S` son rupturas de cuerpo con volumen confirmado (osc EMA(5)/EMA(10) > umbral); `Bull Wick` y `Bear Wick` son rupturas con mecha mayor que el cuerpo (rechazo, sin filtro de volumen). El reporte humano y `lastVisibleBreak` solo muestran estas 4. El JSON completo además incluye `B_unconfirmed` / `S_unconfirmed` (cruces de cuerpo con volumen bajo) en `breaks`, útiles para faders avanzados.

Smart money en `market-snapshot` se reporta como `n/d (no aplica para perpetuos CEX)` — la skill on-chain solo cubre tokens DEX. El estado interno de `watchlist-update` vive en `analysis/.watchlist-state.json` (gitignored).

## Estructura

```
binance-trading-assistant/
├── analysis/          # watchlist, trade log, reglas condensadas
├── scripts/           # utilidades Node.js (market-snapshot, etc.)
├── charts/            # capturas de TradingView (charts/private/ ignorado)
├── .claude/skills/    # Binance Skills Hub (instaladas vía npx skills add, snapshot --copy)
├── CLAUDE.md          # contexto e instrucciones para el agente
├── PRD.md             # product requirements document
├── README.md          # este archivo
└── .env.example       # plantilla de configuración
```

## Reglas críticas

Las reglas de trading no negociables (3 de 4 confluencias, stop-loss obligatorio, tiers de tamaño, banderas psicológicas) están en [`analysis/system-rules.md`](analysis/system-rules.md). Léelas antes de cada trade.

**Disclaimer:** este repositorio es una herramienta personal de aprendizaje. No constituye consejo financiero. El operador asume el 100% del riesgo de sus decisiones.
