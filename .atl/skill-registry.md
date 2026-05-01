# Skill Registry

**Orchestrator use only.** Read this registry once per session to resolve skill paths, then pass pre-resolved paths directly to each sub-agent's launch prompt. Sub-agents receive the path and load the skill directly — they do NOT read this registry.

## User Skills

| Trigger | Skill | Path |
|---------|-------|------|
| _(none — only SDD workflow skills installed under `~/.claude/skills/`, which are skipped by registry policy)_ | — | — |

No user-level coding/task skills are installed. The user has only SDD workflow skills (`sdd-*`, `_shared`, `skill-registry`) at `~/.claude/skills/`, all of which are excluded from this registry per the `skill-registry` skill rules.

## Project Skills

| Trigger | Skill | Path |
|---------|-------|------|
| Token rankings, market trends, social buzz, meme rankings, breakout meme tokens, top traders | crypto-market-rank | `/Users/rentadvisor/Documents/personal/binance/binance-trading-assistant/.claude/skills/crypto-market-rank/SKILL.md` |
| "is this token safe?", "check token security", "audit token", or before any swap | query-token-audit | `/Users/rentadvisor/Documents/personal/binance/binance-trading-assistant/.claude/skills/query-token-audit/SKILL.md` |
| Search tokens, check token prices, view market data, request kline/candlestick charts | query-token-info | `/Users/rentadvisor/Documents/personal/binance/binance-trading-assistant/.claude/skills/query-token-info/SKILL.md` |
| On-chain smart money signals — buy/sell, trigger price, current price, max gain, exit rate | trading-signal | `/Users/rentadvisor/Documents/personal/binance/binance-trading-assistant/.claude/skills/trading-signal/SKILL.md` |

These four HIGH priority skills (Binance Skills Hub) were installed via `npx skills add ... --copy` and are snapshot-tracked under `.claude/skills/<name>/`. Re-run `npx skills update` (Node 22+) to refresh from upstream `binance/binance-skills-hub`.

## Project Conventions

| File | Path | Notes |
|------|------|-------|
| CLAUDE.md | `/Users/rentadvisor/Documents/personal/binance/binance-trading-assistant/CLAUDE.md` | Operational instructions for Claude Code: trade rules, position sizing, psychological safeguards, expected output structure |
| PRD.md | `/Users/rentadvisor/Documents/personal/binance/binance-trading-assistant/PRD.md` | Product requirements (v0.1.0): vision, modes, technical system, non-negotiable trade rules, tooling, project structure, execution plan |

Read the convention files listed above for project-specific patterns and rules. All referenced paths have been extracted — no need to read index files to discover more.
