/**
 * The Studio MCP GATEWAY for `exa web` — the same idea as the desktop app's
 * gateway bus, hosted BY the engine: one `exasol-studio` MCP entry in an AI
 * client speaks for every database connected here. External clients reach it
 * over streamable HTTP at /studio-mcp (written into their configs via
 * `npx mcp-remote`, which bridges stdio clients to HTTP).
 *
 * Read-only by construction: only a single SELECT / WITH / DESCRIBE statement
 * is accepted, and no credentials ever leave the engine — clients hold only
 * the localhost URL.
 */
import os from "os"
import path from "path"
import { promises as fs } from "fs"
import { listConnections } from "../database/connection"
import { withDriver, rowsOf } from "./studio-ipc"

const GATEWAY_FILE = () => path.join(os.homedir(), ".exasol", "web-gateway.json")

type GatewayConfig = {
  databases: Record<string, { exposed?: boolean; caps?: { sql?: boolean; nl2sql?: boolean } }>
  services: Record<string, boolean>
}

async function readConfig(): Promise<GatewayConfig> {
  try {
    const raw = JSON.parse(await fs.readFile(GATEWAY_FILE(), "utf8")) as GatewayConfig
    return { databases: raw.databases ?? {}, services: raw.services ?? {} }
  } catch {
    return { databases: {}, services: {} }
  }
}

async function writeConfig(cfg: GatewayConfig) {
  await fs.mkdir(path.dirname(GATEWAY_FILE()), { recursive: true }).catch(() => undefined)
  await fs.writeFile(GATEWAY_FILE(), JSON.stringify(cfg, null, 2))
}

/** Exposure + service state in the exact shape the app's /gateway API uses. */
export async function gatewayState() {
  const [cfg, conns] = await Promise.all([readConfig(), listConnections()])
  return {
    databases: conns.map((c) => {
      const d = cfg.databases[c.id] ?? {}
      return {
        id: c.id,
        name: c.name,
        exposed: d.exposed ?? true,
        caps: { sql: d.caps?.sql ?? true, nl2sql: d.caps?.nl2sql ?? false },
      }
    }),
    services: [{ id: "dashboards", exposed: cfg.services["dashboards"] ?? false }],
  }
}

export async function setGatewayDatabase(id: string, patch: { exposed?: boolean; caps?: { sql?: boolean; nl2sql?: boolean } }) {
  const cfg = await readConfig()
  const cur = cfg.databases[id] ?? {}
  cfg.databases[id] = {
    exposed: patch.exposed ?? cur.exposed,
    caps: { ...cur.caps, ...patch.caps },
  }
  await writeConfig(cfg)
}

export async function setGatewayService(id: string, exposed: boolean) {
  const cfg = await readConfig()
  cfg.services[id] = exposed
  await writeConfig(cfg)
}

/** The desktop gateway's rule, verbatim: one statement, reads only. */
export function readOnlySql(sql: string): string | null {
  const trimmed = sql.trim().replace(/;\s*$/, "")
  if (!trimmed) return "Empty statement."
  if (trimmed.includes(";")) return "One statement per call — no batches."
  if (!/^(select|with|describe|desc)\b/i.test(trimmed)) {
    return "Read-only gateway: only a single SELECT, WITH, or DESCRIBE statement is accepted."
  }
  return null
}

const TOOLS = [
  {
    name: "list_databases",
    description:
      "List the Exasol databases connected in Exasol Studio that are exposed on this gateway, with their capabilities.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "sql_query",
    description:
      "Run a single read-only SQL statement (SELECT / WITH / DESCRIBE) against one of the exposed databases and return the rows. Never modifies data.",
    inputSchema: {
      type: "object",
      properties: {
        database: { type: "string", description: "Database name or id from list_databases. Optional when exactly one is exposed." },
        sql: { type: "string", description: "One SELECT / WITH / DESCRIBE statement." },
      },
      required: ["sql"],
      additionalProperties: false,
    },
  },
]

async function exposedDatabases() {
  const state = await gatewayState()
  return state.databases.filter((d) => d.exposed && d.caps.sql)
}

function textResult(text: string, isError = false) {
  return { content: [{ type: "text", text }], isError }
}

async function callTool(name: string, args: Record<string, unknown>) {
  if (name === "list_databases") {
    const dbs = await exposedDatabases()
    if (!dbs.length) return textResult("No databases are exposed on the gateway. Connect one in Exasol Studio.")
    return textResult(JSON.stringify(dbs.map((d) => ({ id: d.id, name: d.name, services: d.caps })), null, 2))
  }
  if (name === "sql_query") {
    const sql = String(args["sql"] ?? "")
    const guard = readOnlySql(sql)
    if (guard) return textResult(guard, true)
    const dbs = await exposedDatabases()
    const wanted = String(args["database"] ?? "")
    const target = wanted
      ? dbs.find((d) => d.id === wanted || d.name.toLowerCase() === wanted.toLowerCase())
      : dbs.length === 1
        ? dbs[0]
        : undefined
    if (!target) {
      return textResult(
        wanted
          ? `No exposed database called "${wanted}". Available: ${dbs.map((d) => d.name).join(", ") || "none"}.`
          : `Several databases are exposed — pass "database". Available: ${dbs.map((d) => d.name).join(", ")}.`,
        true,
      )
    }
    try {
      const rows = await withDriver(target.id, async (d) => rowsOf(await d.query(sql.trim().replace(/;\s*$/, ""))))
      const limited = rows.slice(0, 200)
      return textResult(
        JSON.stringify({ database: target.name, rowCount: rows.length, truncated: rows.length > limited.length, rows: limited }, null, 2),
      )
    } catch (error) {
      return textResult(`Query failed: ${error instanceof Error ? error.message : String(error)}`, true)
    }
  }
  return textResult(`Unknown tool: ${name}`, true)
}

type JsonRpc = { jsonrpc?: string; id?: unknown; method?: string; params?: Record<string, unknown> }

/** Minimal streamable-HTTP MCP: one JSON response per POST, no SSE.
 *  Returns undefined for notifications (respond 202 with no body). */
export async function handleStudioMcp(body: unknown): Promise<unknown | undefined> {
  const msg = (body ?? {}) as JsonRpc
  const reply = (result: unknown) => ({ jsonrpc: "2.0", id: msg.id ?? null, result })
  const fail = (code: number, message: string) => ({ jsonrpc: "2.0", id: msg.id ?? null, error: { code, message } })
  switch (msg.method) {
    case "initialize":
      return reply({
        protocolVersion: String(msg.params?.["protocolVersion"] ?? "2025-03-26"),
        capabilities: { tools: {} },
        serverInfo: { name: "exasol-studio", version: "1.0.0" },
        instructions:
          "Read-only gateway to the Exasol databases connected in Exasol Studio. Start with list_databases, then sql_query.",
      })
    case "ping":
      return reply({})
    case "tools/list":
      return reply({ tools: TOOLS })
    case "tools/call": {
      const name = String(msg.params?.["name"] ?? "")
      const args = (msg.params?.["arguments"] ?? {}) as Record<string, unknown>
      return reply(await callTool(name, args))
    }
    default:
      if (msg.method?.startsWith("notifications/")) return undefined
      return fail(-32601, `Method not implemented: ${msg.method}`)
  }
}
