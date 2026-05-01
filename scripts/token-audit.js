#!/usr/bin/env node
// token-audit.js
// Auditoría rápida de seguridad para un token (anti-scam, honeypot, etc.).
//
// Uso:
//   node scripts/token-audit.js TOKEN              # smart mode: resuelve por símbolo
//   node scripts/token-audit.js CHAIN ADDRESS      # explicit mode
//   node scripts/token-audit.js TOKEN --json
//   node scripts/token-audit.js CHAIN ADDRESS --json
//
// Smart mode flujo:
//   1) GET query-token-info search por keyword=TOKEN.
//   2) Tomar top match -> chain (chainId), address (contractAddress), name.
//   3) Imprimir cabecera "Resuelto: ...".
//   4) POST query-token-audit con { binanceChainId, contractAddress, requestId }.
//
// Explicit mode salta resolución y va directo a la auditoría.

import { randomUUID } from "node:crypto";
import { fetchJson } from "./lib/http.js";

const SEARCH_URL =
  "https://web3.binance.com/bapi/defi/v5/public/wallet-direct/buw/wallet/market/token/search/ai";
const AUDIT_URL =
  "https://web3.binance.com/bapi/defi/v1/public/wallet-direct/security/token/audit";

const COMMON_HEADERS = {
  "Accept-Encoding": "identity",
  "User-Agent": "binance-web3/1.4 (Skill)",
};

// Mapeo chainId <-> nombre legible (subset documentado en las skills).
const CHAIN_ID_TO_NAME = {
  "1": "ETH",
  "56": "BSC",
  "8453": "BASE",
  CT_501: "SOL",
};
const CHAIN_NAME_TO_ID = {
  ETH: "1",
  ETHEREUM: "1",
  BSC: "56",
  BNB: "56",
  BASE: "8453",
  SOL: "CT_501",
  SOLANA: "CT_501",
};

function parseArgs(argv) {
  const flags = { json: false };
  const positionals = [];
  for (const arg of argv) {
    if (arg === "--json") flags.json = true;
    else if (arg.startsWith("--")) {
      throw new Error(`Flag desconocida: ${arg}`);
    } else {
      positionals.push(arg);
    }
  }
  return { flags, positionals };
}

function usage() {
  process.stderr.write(
    "Uso: node scripts/token-audit.js TOKEN [--json]\n" +
      "     node scripts/token-audit.js CHAIN ADDRESS [--json]\n" +
      "  TOKEN  : símbolo (ej. AXL, VIRTUAL).\n" +
      "  CHAIN  : ETH | BSC | BASE | SOL.\n"
  );
}

function chainLabel(chainId) {
  if (!chainId) return "—";
  return CHAIN_ID_TO_NAME[String(chainId)] || String(chainId);
}

function normalizeChainArg(chain) {
  const upper = String(chain).toUpperCase();
  if (CHAIN_NAME_TO_ID[upper]) return CHAIN_NAME_TO_ID[upper];
  // Permite pasar el chainId directo (56, 8453, 1, CT_501).
  if (CHAIN_ID_TO_NAME[upper]) return upper;
  if (CHAIN_ID_TO_NAME[chain]) return chain;
  throw new Error(
    `Chain desconocida: ${chain}. Esperado: ETH, BSC, BASE, SOL (o chainId 1/56/8453/CT_501).`
  );
}

async function resolveSymbol(symbol) {
  const url = `${SEARCH_URL}?keyword=${encodeURIComponent(symbol)}&chainIds=56,8453,CT_501,1&orderBy=volume24h`;
  const res = await fetchJson(url, { headers: COMMON_HEADERS });
  const data = Array.isArray(res?.data) ? res.data : [];
  if (data.length === 0) return null;
  // Top match: el endpoint ya ordena por volume24h cuando se pide.
  const top = data[0];
  return {
    chainId: top.chainId,
    address: top.contractAddress,
    name: top.name,
    symbol: top.symbol,
  };
}

async function runAudit(chainId, address) {
  const body = {
    binanceChainId: String(chainId),
    contractAddress: address,
    requestId: randomUUID(),
  };
  const res = await fetchJson(AUDIT_URL, {
    method: "POST",
    body,
    headers: { ...COMMON_HEADERS, "Content-Type": "application/json", source: "agent" },
  });
  return res?.data || null;
}

function renderResolution(resolution) {
  const lines = [];
  lines.push("# Resolución de token");
  lines.push(`- Símbolo:      ${resolution.symbol || "—"}`);
  lines.push(`- Match top:    ${resolution.name || "—"}`);
  lines.push(`- Chain:        ${chainLabel(resolution.chainId)} (${resolution.chainId})`);
  lines.push(`- Address:      ${resolution.address || "—"}`);
  return lines.join("\n");
}

function renderAudit(audit, resolution) {
  if (!audit) {
    return "Auditoría: respuesta vacía del servicio.";
  }
  const lines = [];
  lines.push("");
  lines.push("# Auditoría de seguridad");
  if (audit.hasResult === false || audit.isSupported === false) {
    lines.push("Estado: datos no disponibles (hasResult/isSupported = false).");
    lines.push("Sugerencia: verifica chain + address, o reintenta más tarde.");
    return lines.join("\n");
  }
  lines.push(`- Nivel de riesgo: ${audit.riskLevelEnum || "—"} (${audit.riskLevel ?? "—"}/5)`);
  if (audit.extraInfo) {
    const e = audit.extraInfo;
    lines.push(`- Buy tax:         ${e.buyTax ?? "—"}`);
    lines.push(`- Sell tax:        ${e.sellTax ?? "—"}`);
    if (typeof e.isVerified === "boolean") {
      lines.push(`- Contrato verificado: ${e.isVerified ? "sí" : "no"}`);
    }
  }

  const items = Array.isArray(audit.riskItems) ? audit.riskItems : [];
  if (items.length > 0) {
    lines.push("");
    lines.push("## Items de riesgo");
    for (const cat of items) {
      const details = Array.isArray(cat.details) ? cat.details : [];
      const hits = details.filter((d) => d.isHit);
      const total = details.length;
      lines.push(`- ${cat.name || cat.id}: ${hits.length}/${total} flags activos`);
      for (const d of hits) {
        lines.push(`  • [${d.riskType || "?"}] ${d.title}`);
      }
    }
  }
  lines.push("");
  lines.push(
    "⚠️ Solo referencia. No es consejo de inversión. Audita siempre por tu cuenta."
  );
  if (resolution) {
    // Recordatorio del contexto resuelto.
  }
  return lines.join("\n");
}

async function main() {
  let parsed;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`Error: ${err.message}\n`);
    usage();
    process.exit(1);
  }
  const { flags, positionals } = parsed;

  if (positionals.length === 0) {
    process.stderr.write("Error: faltan argumentos.\n");
    usage();
    process.exit(1);
  }

  let resolution = null;
  let chainId;
  let address;

  if (positionals.length === 1) {
    // Smart mode
    const symbol = positionals[0];
    try {
      resolution = await resolveSymbol(symbol);
    } catch (err) {
      process.stderr.write(`Error: falló la búsqueda de token — ${err.message}\n`);
      process.exit(2);
    }
    if (!resolution) {
      process.stderr.write(`Error: no se encontró ningún token con símbolo "${symbol}"\n`);
      process.exit(2);
    }
    chainId = resolution.chainId;
    address = resolution.address;
    if (!flags.json) {
      process.stdout.write(renderResolution(resolution) + "\n");
    }
  } else if (positionals.length === 2) {
    // Explicit mode
    const [rawChain, rawAddress] = positionals;
    try {
      chainId = normalizeChainArg(rawChain);
    } catch (err) {
      process.stderr.write(`Error: ${err.message}\n`);
      process.exit(1);
    }
    address = rawAddress;
  } else {
    process.stderr.write(`Error: argumentos extra: ${positionals.slice(2).join(" ")}\n`);
    usage();
    process.exit(1);
  }

  let audit;
  try {
    audit = await runAudit(chainId, address);
  } catch (err) {
    process.stderr.write(`Error: falló la auditoría — ${err.message}\n`);
    process.exit(2);
  }

  if (flags.json) {
    const out = { resolution, audit };
    process.stdout.write(JSON.stringify(out, null, 2) + "\n");
    return;
  }

  process.stdout.write(renderAudit(audit, resolution) + "\n");
}

await main();
