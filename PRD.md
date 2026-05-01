# PRD — Binance Trading Assistant

**Versión:** 0.1.0
**Estado:** Draft / Setup inicial
**Última actualización:** 2026-04-30
**Owner:** [tu nombre]

---

## 1. Visión

Construir un entorno de trabajo permanente, basado en Claude Code y las skills oficiales de Binance Skills Hub, que asista al operador en:

1. **Investigación** de mercado (datos cuantitativos, smart money flows, auditoría de tokens)
2. **Análisis técnico** de pares (combinando datos del API con capturas de TradingView)
3. **Toma de decisiones** disciplinada (entrada, stop, TPs, gestión de riesgo)
4. **Eventual ejecución** de trades (testnet primero, mainnet después de validación)

El objetivo no es construir un bot autónomo, sino un **co-piloto disciplinado** que filtre datos, valide setups contra reglas predefinidas y proteja al operador de errores psicológicos comunes.

## 2. Contexto del operador

- **Perfil técnico:** desarrollador de software (cómodo con CLI, Node, Python, Git, npm/uvx)
- **Perfil de trading:** principiante, aprendiendo activamente
- **Capital actual:** $144 USDT en Binance Futures
- **Plataforma:** Binance Futures (perpetuos USD-M)
- **Limitaciones:** mínimos de orden de Binance obligan a usar apalancamiento alto en BTC ($9 nominal mínimo con 15x); altcoins son más flexibles ($2-5 con 3-5x)

### Histórico relevante

El operador ha completado al menos un trade real (BTC, entrada $76.830, stop $75.400, pérdida $5.60). Ha demostrado capacidad para resistir FOMO en al menos una ocasión documentada. Está en fase de construcción de sistema, no de generación de retorno.

## 3. Modos de operación

El proyecto soporta tres modos, controlados por `BINANCE_MODE` en `.env`:

| Modo | Descripción | Cuándo usar |
|---|---|---|
| `analysis_only` | Solo lectura de datos, sin ejecución posible | Por defecto. Investigación, análisis, aprendizaje |
| `testnet` | Ejecución contra Binance Testnet (dinero falso) | Validación de scripts y estrategias antes de mainnet |
| `mainnet` | Ejecución contra cuenta real | Solo después de 30+ trades testnet documentados con resultados positivos |

**Regla:** cualquier ejecución en `mainnet` requiere confirmación explícita del operador en cada orden, sin excepciones.

## 4. Sistema técnico del operador

El operador toma decisiones combinando dos fuentes de información:

### 4.1 Datos cuantitativos (vía Binance Skills + API)

- Precio en tiempo real
- Velas (K-Line) de cualquier timeframe
- Funding rate (clave para sesgo direccional en futuros)
- Long/short ratio
- Smart money signals
- Auditoría de seguridad de tokens
- Rankings: trending, top traders, smart money inflow
- Información on-chain de wallets

### 4.2 Indicadores visuales (vía TradingView, capturas manuales)

- **UT Bot Alerts**
  - Etiqueta `Buy` (verde) → señal de entrada larga (cruce ATR)
  - Etiqueta `Sell` (roja) → señal de salida o entrada corta
- **LuxAlgo Support and Resistance with Breaks**
  - Etiqueta `B` → bullish break confirmado
  - Etiqueta `S` → bearish break confirmado
  - Líneas horizontales rojas → resistencias
  - Líneas horizontales azules → soportes

### 4.3 Timeframes

- **1H:** análisis principal y timing de entrada
- **4H:** confirmación de tendencia y validación de niveles
- **1D:** contexto macro

### 4.4 Roadmap de evolución del sistema

- **Fase 1 (actual):** flujo híbrido (skills + capturas manuales de TradingView)
- **Fase 2 (1-2 meses):** implementar UT Bot y LuxAlgo S&R en código local sobre velas de Binance API. Eliminar dependencia de capturas
- **Fase 3 (3-6 meses):** pipeline completo (indicadores + reglas + gestión de riesgo) ejecutable como script único

## 5. Reglas de trade (no negociables)

### 5.1 Confluencia mínima para entrada

Solo recomendar entrada si se cumplen **al menos 3 de 4** condiciones:

1. Señal del UT Bot en la dirección del trade (verificación visual)
2. Confluencia con LuxAlgo S&R (verificación visual)
3. Volumen acompañando el movimiento (verificación visual o API)
4. Contexto BTC alineado con la dirección (verificación API)

Si las 4 condiciones no se pueden verificar (por ejemplo, no hay captura de TradingView disponible), no recomendar entrada por defecto. Indicar qué falta verificar.

### 5.2 Gestión de salida

- **Stop-loss:** SIEMPRE definido antes de la entrada, con base técnica (debajo de soporte / arriba de resistencia, no por porcentaje arbitrario)
- **Take-profit por niveles:** 50% en TP1, 30% en TP2, dejar 20% con trailing stop a breakeven después de TP1
- **R:R mínimo:** 1:2 (si TP1 implica menos, no abrir el trade)

> **Nota V1a (`confluenceEngine`):** la implementación inicial de la estrategia en backtest usa **TP único @ 2.5R** (cumple R:R ≥ 1:2 con 0.5R de margen sobre slippage) en lugar del ladder 50/30/20. La ladder requiere extensiones al harness de posición (TPs parciales + trailing a breakeven después de TP1) y queda deferida al follow-up `confluence-engine-tp-ladder` para mantener el cambio actual acotado a lógica de entrada. La regla operativa para el operador humano sigue siendo el ladder 50/30/20 — la simplificación V1a aplica sólo al backtest.

### 5.3 Tamaño de posición

| Tier | Monedas | Tamaño USDT | Apalancamiento |
|---|---|---|---|
| 1 | BTC, ETH, SOL, XRP | $5–$15 | 5–10x (15x solo BTC por mínimos) |
| 2 | BIO, AXL, VIRTUAL, TAO | $2–$5 | 3–5x |
| 3 | DOGE, 1000BONK, WIF, PENGU | $1–$3 | 2–3x |

**Pérdida máxima por trade:** 3% del capital total (~$4.30 con $144 actual)

## 6. Protecciones psicológicas

Claude Code debe activar advertencias o cuestionar al operador en estos casos:

- **Revenge trading:** operador acaba de perder un trade y quiere entrar de inmediato
- **Shilling:** operador menciona moneda "vista en chat", "alguien le dijo", influencer. Sugerir auditar primero con `query-token-audit`
- **Catching falling knife:** operador quiere entrar en moneda muy castigada sin confirmación de reversión
- **FOMO operacional:** operador pide aprobación constante para múltiples trades seguidos
- **Escalación injustificada:** operador quiere subir tamaño/apalancamiento sin razón técnica clara
- **Operación fuera de tiers:** operador opera moneda no en watchlist o con tamaño/apalancamiento fuera de los rangos definidos

## 7. Tooling

### 7.1 Skills oficiales de Binance Skills Hub

Repositorio: https://github.com/binance/binance-skills-hub

#### Prioridad ALTA — instalar primero (no requieren permisos de trading)

- [x] `query-token-info` — info de tokens, K-Line, market data (instalada en `.claude/skills/query-token-info/`)
- [x] `query-token-audit` — auditoría de seguridad de tokens (anti-scam, anti-honeypot) (instalada en `.claude/skills/query-token-audit/`)
- [x] `crypto-market-rank` — rankings, smart money flows, top traders, trending (instalada en `.claude/skills/crypto-market-rank/`)
- [x] `trading-signal` — smart money signals on-chain (instalada en `.claude/skills/trading-signal/`)

#### Prioridad MEDIA — instalar después de validar las anteriores

- [ ] `meme-rush` — discovery de tokens nuevos en launchpads (Pump.fun, Four.meme)
- [ ] `query-address-info` — análisis on-chain de wallets

#### Prioridad BAJA — NO instalar todavía

- `spot`, `futures`, `agentic-wallet` — requieren API key con permisos de trading. Instalar solo cuando se vaya a operar testnet, no antes.

### 7.2 Scripts custom a crear

Ubicación: `scripts/`

- `market-snapshot.js` — snapshot de BTC, ETH, SOL: precio, funding rate, long/short ratio, smart money signal
- `token-audit.js` — wrapper de auditoría: `node scripts/token-audit.js TOKEN`
- `watchlist.js` — lee `analysis/watchlist.md`, consulta precios actuales y reporta cambios desde la última consulta

### 7.3 Comandos npm a configurar

```bash
npm run market-snapshot      # snapshot rápido del mercado
npm run token-audit TOKEN    # auditar seguridad de un token
npm run watchlist-update     # actualizar y reportar watchlist
npm run signals PAR TIMEFRAME  # (futuro, fase 2) señales calculadas localmente
```

## 8. Estructura del proyecto

binance-trading-assistant/
├── PRD.md                  # este documento
├── CLAUDE.md               # instrucciones para Claude Code (derivadas del PRD)
├── README.md               # cómo usar el proyecto
├── .env                    # API keys (gitignored)
├── .gitignore
├── .claude/skills/         # skills instaladas (vía npx skills add, snapshot --copy)
├── analysis/
│   ├── watchlist.md        # tokens en seguimiento por tier
│   ├── trade-log.md        # diario de trades
│   └── system-rules.md     # versión condensada de las reglas de trade
├── charts/                 # capturas de TradingView (gitignored)
├── scripts/                # utilidades custom
└── package.json

## 9. Output esperado al pedir análisis de una moneda

Cuando el operador pida "analiza X", Claude Code debe responder con esta estructura:

1. **Datos cuantitativos vía skills:**
   - Precio actual
   - Funding rate
   - Long/short ratio
   - Smart money signal (si aplica)
   - Auditoría de seguridad (si es token nuevo o fuera de watchlist conocida)

2. **Si requiere análisis visual:** pedir captura de TradingView (idealmente 1H + 4H)

3. **Una vez con captura:**
   - Estructura de precio (alcista/bajista/lateral)
   - Niveles clave (S&R LuxAlgo)
   - Estado del UT Bot (último Buy/Sell, si está activo)

4. **Contexto BTC** (siempre, dado que afecta a todas las altcoins)

5. **Escenarios probabilísticos** con porcentajes subjetivos (no certezas)

6. **Plan de trade** SI hay setup válido (3+ confluencias):
   - Entrada
   - Stop-loss
   - TP1, TP2, TP3
   - Tamaño de posición en USDT
   - Apalancamiento
   - Pérdida máxima esperada en USDT
   - R:R esperado

7. **Si no hay setup válido:**
   - Razón clara
   - Alerta sugerida en TradingView (precio + condición) para no tener que mirar el chart constantemente

## 10. Logging y disciplina

### 10.1 Trade log

Cada trade ejecutado (incluyendo testnet) se documenta en `analysis/trade-log.md` con este formato:

YYYY-MM-DD HH:MM — PAR — LONG/SHORT

Setup: [confluencias verificadas, ej: UT Bot Buy + LuxAlgo break + BTC alineado]
Entrada: $X.XX
Stop: $X.XX (riesgo: $Y)
TP1/TP2/TP3: $X.XX / $X.XX / $X.XX
Tamaño: $Z con apalancamiento Nx
Resultado: [pendiente / +X/−X / -
X/−X]
Lección: [qué aprendí]

### 10.2 Métricas a evaluar después de 30 trades

- Win rate
- Profit factor
- Max drawdown
- R:R promedio realizado vs. planeado
- Adherencia al sistema (trades dentro de reglas vs. fuera de reglas)

Si win rate < 55% con R:R 1:2, el sistema NO tiene edge y requiere ajuste antes de seguir operando real.

## 11. Backtesting (Fase 2)

Una vez los indicadores estén implementados localmente:

- Correr el sistema completo (UT Bot + LuxAlgo S&R + reglas de confluencia + gestión de riesgo) sobre 6 meses de velas históricas para BTC, ETH, SOL
- Validar métricas: win rate, profit factor, max drawdown, expectancy
- Solo si los resultados son positivos, proceder a testnet con dinero falso

### 11.1 Harness de backtest y baseline `utBotOnly`

El harness vive en `scripts/backtest.js` + `scripts/lib/backtest/` y es ejecutable con `npm run backtest -- SYMBOL [INTERVAL]`. Outputs en `analysis/backtests/{runId}/` (gitignored): `report.md`, `trades.csv`, `equity.csv`, `result.json`, `klines.json` (snapshot para `--replay`).

V1 ship sólo la estrategia `utBotOnly` — long-only, una posición a la vez, entrada en UT Bot Buy al next bar's open con stop = trailing-stop value, salida en UT Bot Sell al close. Sin filtro de confluencia, sin contexto BTC, sin TP por niveles. Es **baseline** explícito, para medir cuánto suma la confluencia.

### 11.2 Gate de promoción a testnet

**El gate de win rate > 55% y R:R promedio > 1:2 se evalúa contra el backtest del `confluenceEngine`** (la estrategia que implementa la regla 3-de-4 + contexto BTC + R:R filter), NO contra `utBotOnly`. La baseline existe sólo como punto de referencia: si `confluenceEngine` no supera al baseline en una ventana de 6 meses sobre BTC/ETH/SOL, el sistema no tiene edge y no se promueve a testnet.

**V1a `confluenceEngine`** ship con **TP único @ 2.5R** (deferida la ladder 50/30/20 al follow-up `confluence-engine-tp-ladder`). El gate se evalúa con esta versión simplificada — si supera al baseline con TP único, podemos promover a testnet sin esperar la ladder; si no supera, la ladder probablemente tampoco salvará el sistema y hay que revisitar reglas de entrada antes que reglas de salida.

## 12. Seguridad

### 12.1 API keys

- **Permisos habilitados:** Reading; Spot/Margin Trading y Futures **solo** cuando se opere testnet
- **Permisos prohibidos:** Withdrawals, Universal Transfer (jamás)
- **IP Whitelist:** habilitada con IP del operador
- Almacenamiento: archivo `.env` (gitignored), nunca hardcodear

### 12.2 Prompt injection

Las skills inyectan datos externos (token info, signals) en el contexto. Riesgo teórico de instrucciones maliciosas embebidas en metadata.

Mitigaciones:
- API key sin permisos de retiro
- `BINANCE_MODE=analysis_only` por defecto
- Confirmación explícita del operador para cada orden en mainnet
- Nunca dejar Claude Code corriendo desatendido con permisos de trading reales

### 12.3 Sub-cuenta de Binance

Recomendación: cuando se vaya a operar mainnet, hacerlo desde una **sub-cuenta** dedicada para este proyecto, no desde la cuenta principal. Aislamiento de fondos.

## 13. Plan de ejecución (próximas 2 semanas)

### Semana 1: Setup y modo research

- Día 1: instalación de skills de PRIORIDAD ALTA, scripts utilitarios, watchlist inicial
- Días 2-7: análisis manual de 10 setups usando Claude Code + skills, sin ejecución. Documentar cada uno

### Semana 2: Backtesting y testnet

- Días 8-10: implementar indicadores localmente (UT Bot, LuxAlgo S&R simplificado)
- Días 11-12: backtest sobre 6 meses BTC/ETH/SOL
- Días 13-14: si métricas positivas, conectar testnet y ejecutar primeros 5 trades simulados

Después de eso: evaluación, ajuste, decisión sobre mainnet.

## 14. Criterios de éxito

### Corto plazo (30 días)

- Skills instaladas y funcionando
- Scripts utilitarios operativos
- Al menos 20 análisis documentados (con o sin trade)
- 0 trades ejecutados en mainnet sin pasar por testnet primero

### Mediano plazo (90 días)

- Sistema indicadores en código local funcionando
- 30+ trades documentados (testnet o mainnet)
- Win rate > 55% con R:R promedio > 1:2
- Cero violaciones a reglas de tamaño/apalancamiento por moneda

### Largo plazo (6 meses)

- Decisión informada: el sistema tiene edge real o requiere replanteo
- Capital crecido o, en su defecto, no perdido más allá del 30% por aprendizaje
- Disciplina psicológica medible (cero revenge trades en últimos 30 días)

## 15. Out of scope (lo que este proyecto NO es)

- **No es un bot autónomo.** Las decisiones finales siempre las toma el operador.
- **No es asesoría financiera.** El sistema asiste, no garantiza nada.
- **No es generador de retornos rápidos.** Con $144 de capital, el objetivo primario es educativo.
- **No reemplaza disciplina.** Ninguna IA evita revenge trading si el operador insiste.

## 16. Próximos pasos inmediatos

1. Operador: confirma que el PRD refleja correctamente sus expectativas
2. Operador: ajusta secciones específicas si es necesario
3. Una vez aprobado el PRD, generar `CLAUDE.md` derivado (versión operativa para Claude Code)
4. Iniciar sesión de Claude Code con el PRD como contexto y proceder con la fase de instalación