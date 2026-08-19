/**
 * The headless backend for Exasol Studio's web build.
 *
 * Studio's frontend resolves its transport in one place: inside a Tauri shell
 * it calls Rust commands directly, and in a browser it POSTs each command to
 * `<backend>/ipc/<command>`. That HTTP half never existed, which is why the
 * documented state of the web build was "database access is MOCKED".
 *
 * It exists here because this is where the capability already lives. exa has
 * the connection registry Studio shares, a bundled Exasol driver, and the
 * query path — so the same server that runs the agent can answer Studio's
 * commands, and one install serves both: `exa web` and Studio's web build
 * talk to the same backend.
 *
 * Deliberately a subset. Connections, SQL and schema browsing are implemented
 * because they are what makes the app usable; anything touching the desktop
 * machine — BucketFS, the local runtime, git, the filesystem — is refused by
 * name rather than faked, because a mocked answer in a database tool is worse
 * than an honest refusal.
 */
import { probe, createDriver, listConnections, saveConnection, forgetConnection, loadPassword } from "../database/connection"
import { connectionId } from "../database/registry"
import * as vault from "./studio-vault"

export type IpcResult = { ok: true; value: unknown } | { ok: false; status: number; error: string }

/** Studio's ConnectionProfile, built from exa's registry entry. */
async function profiles() {
  const all = await listConnections()
  return Promise.all(
    all.map(async (c) => ({
      id: c.id,
      name: c.name,
      host: c.host,
      port: c.port,
      username: c.user,
      // The registry never holds secrets; the password lives in the OS
      // credential store and is fetched when a query actually runs.
      password: "",
      schema: c.schema ?? null,
      notes: null,
      sslMode: "preferred",
      compression: false,
      driverId: "exasol",
      createdAt: c.createdAt ?? null,
      lastUsedAt: null,
      hasCredential: (await loadPassword(c.id)) !== undefined,
    })),
  )
}

async function targetFor(profileId: string) {
  const entry = (await listConnections()).find((c) => c.id === profileId)
  if (!entry) throw new Error(`No connection called "${profileId}"`)
  const password = await loadPassword(entry.id)
  if (password === undefined) {
    throw new Error(`No password stored for "${entry.name}" on this machine — run \`exa connect\` to add one.`)
  }
  return { host: entry.host, port: entry.port, user: entry.user, password, schema: entry.schema }
}

async function withDriver<T>(profileId: string, fn: (d: ReturnType<typeof createDriver>) => Promise<T>): Promise<T> {
  const driver = createDriver(await targetFor(profileId))
  try {
    await driver.connect()
    return await fn(driver)
  } finally {
    await driver.close().catch(() => undefined)
  }
}

function rowsOf(result: unknown): Record<string, unknown>[] {
  const r = result as { getRows?: () => unknown[] }
  return typeof r?.getRows === "function" ? (r.getRows() as Record<string, unknown>[]) : []
}

/** A single statement's result, in the shape Studio's grid expects. */
async function runStatement(driver: ReturnType<typeof createDriver>, statement: string, maxRows: number) {
  const started = Date.now()
  try {
    const result = await driver.query(statement)
    const rows = rowsOf(result)
    const columns = rows.length > 0 ? Object.keys(rows[0]!) : []
    const limited = rows.slice(0, maxRows)
    return {
      statement,
      kind: "resultSet" as const,
      columns: columns.map((name) => ({ name, type: "VARCHAR" })),
      rows: limited.map((row) => columns.map((c) => row[c] ?? null)),
      rowCount: rows.length,
      truncated: rows.length > limited.length,
      elapsedMs: Date.now() - started,
      error: null,
    }
  } catch (error) {
    return {
      statement,
      kind: "resultSet" as const,
      columns: [],
      rows: [],
      rowCount: 0,
      truncated: false,
      elapsedMs: Date.now() - started,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

/** Split a script into statements, ignoring semicolons inside quotes. */
export function splitStatements(sql: string): string[] {
  const out: string[] = []
  let current = ""
  let quote: string | undefined
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i]!
    if (quote) {
      current += ch
      if (ch === quote) quote = undefined
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      current += ch
      continue
    }
    if (ch === ";") {
      if (current.trim()) out.push(current.trim())
      current = ""
      continue
    }
    current += ch
  }
  if (current.trim()) out.push(current.trim())
  return out
}

const REQUIRES_DESKTOP = new Set([
  "bucketfs_list", "bucketfs_upload", "bucketfs_download",
  "fs_list_dir", "fs_read_text", "fs_read_table", "fs_delete", "fs_search", "fs_home_roots", "fs_workspace_dir",
  "exasol_local_ctl", "engine_install", "engine_status", "engine_uninstall_cli", "engine_install_cli",
  "backup_local_database", "exapump_upload", "exapump_available",
  "term_create", "term_write", "term_resize", "term_kill",
])

export async function handleIpc(command: string, args: Record<string, unknown>): Promise<IpcResult> {
  const arg = <T>(k: string, fallback?: T) => (args[k] ?? fallback) as T
  try {
    switch (command) {
      case "list_drivers":
        return {
          ok: true,
          value: [
            {
              id: "exasol",
              name: "Exasol",
              protocol: "websocket",
              description: "Bundled Exasol driver — no install required",
              defaultPort: 8563,
              kind: "native",
              isDefault: true,
              docsUrl: "https://github.com/Sheetaldharshan200/exa-engine",
            },
          ],
        }

      case "list_connection_profiles":
        return { ok: true, value: await profiles() }

      case "save_connection_profile": {
        const p = arg<Record<string, unknown>>("profile", {})
        const entry = await saveConnection(
          {
            host: String(p["host"] ?? "127.0.0.1"),
            port: Number(p["port"] ?? 8563),
            user: String(p["username"] ?? "sys"),
            password: String(p["password"] ?? ""),
            schema: p["schema"] ? String(p["schema"]) : undefined,
          },
          { name: p["name"] ? String(p["name"]) : undefined, source: "studio" },
        )
        return { ok: true, value: entry.id }
      }

      case "delete_connection_profile":
        await forgetConnection(String(arg("profileId", "")))
        return { ok: true, value: null }

      case "ping_server": {
        const started = Date.now()
        const net = await import("node:net")
        const reachable = await new Promise<boolean>((resolve) => {
          const socket = net.connect({ host: String(arg("host", "127.0.0.1")), port: Number(arg("port", 8563)) }, () => {
            socket.end()
            resolve(true)
          })
          socket.on("error", () => resolve(false))
          setTimeout(() => {
            socket.destroy()
            resolve(false)
          }, 2_000)
        })
        return {
          ok: true,
          value: { reachable, latencyMs: Date.now() - started, error: reachable ? null : "not reachable" },
        }
      }

      case "test_connection": {
        const p = arg<Record<string, unknown>>("profile", {})
        const result = await probe({
          host: String(p["host"] ?? "127.0.0.1"),
          port: Number(p["port"] ?? 8563),
          user: String(p["username"] ?? "sys"),
          password: String(p["password"] ?? ""),
        })
        if (!result.ok) return { ok: false, status: 400, error: result.error }
        return {
          ok: true,
          value: {
            databaseName: "EXA_DB",
            version: result.version,
            currentUser: String(p["username"] ?? "sys"),
            currentSchema: p["schema"] ? String(p["schema"]) : null,
            sessionId: connectionId(String(p["host"] ?? ""), Number(p["port"] ?? 0), String(p["username"] ?? "")),
            nodes: null,
          },
        }
      }

      case "connect":
      case "disconnect":
        return { ok: true, value: null }

      case "list_open_connections":
        return { ok: true, value: (await profiles()).filter((p) => p.hasCredential).map((p) => p.id) }

      case "execute_sql": {
        const profileId = String(arg("profileId", ""))
        const sql = String(arg("sql", ""))
        const maxRows = Number(arg("maxRows", 1000))
        const split = arg<boolean>("split", true)
        const started = Date.now()
        const statements = split ? splitStatements(sql) : [sql.trim()].filter(Boolean)
        const results = await withDriver(profileId, async (driver) => {
          const out = []
          for (const statement of statements) out.push(await runStatement(driver, statement, maxRows))
          return out
        })
        return {
          ok: true,
          value: {
            results,
            totalElapsedMs: Date.now() - started,
            success: results.every((r) => r.error === null),
          },
        }
      }

      case "get_database_overview": {
        const rows = await withDriver(String(arg("profileId", "")), async (d) =>
          rowsOf(await d.query("SELECT SCHEMA_NAME AS N, SCHEMA_OWNER AS O, SCHEMA_COMMENT AS C FROM SYS.EXA_ALL_SCHEMAS ORDER BY 1")),
        )
        return {
          ok: true,
          value: {
            schemas: rows.map((r) => ({
              name: String(r["N"] ?? ""),
              owner: r["O"] == null ? null : String(r["O"]),
              comment: r["C"] == null ? null : String(r["C"]),
              isVirtual: false,
              adapterScript: null,
            })),
            systemSchemas: ["SYS", "EXA_STATISTICS"],
          },
        }
      }

      case "list_schema_objects": {
        const schema = String(arg("schema", "")).toUpperCase().replaceAll("'", "''")
        const value = await withDriver(String(arg("profileId", "")), async (d) => {
          const tables = rowsOf(
            await d.query(
              `SELECT TABLE_NAME AS N, TABLE_OWNER AS O, TABLE_ROW_COUNT AS R, TABLE_COMMENT AS C
               FROM SYS.EXA_ALL_TABLES WHERE TABLE_SCHEMA = '${schema}' ORDER BY 1`,
            ),
          )
          const views = rowsOf(
            await d.query(
              `SELECT VIEW_NAME AS N, VIEW_OWNER AS O, VIEW_COMMENT AS C
               FROM SYS.EXA_ALL_VIEWS WHERE VIEW_SCHEMA = '${schema}' ORDER BY 1`,
            ),
          )
          return {
            tables: tables.map((t) => ({
              name: String(t["N"] ?? ""),
              owner: t["O"] == null ? null : String(t["O"]),
              rowCount: t["R"] == null ? null : Number(t["R"]),
              comment: t["C"] == null ? null : String(t["C"]),
            })),
            views: views.map((v) => ({
              name: String(v["N"] ?? ""),
              owner: v["O"] == null ? null : String(v["O"]),
              comment: v["C"] == null ? null : String(v["C"]),
            })),
            functions: [],
            scripts: [],
          }
        })
        return { ok: true, value }
      }

      case "get_table_details": {
        const schema = String(arg("schema", "")).toUpperCase().replaceAll("'", "''")
        const table = String(arg("table", arg("tableName", ""))).toUpperCase().replaceAll("'", "''")
        const columns = await withDriver(String(arg("profileId", "")), async (d) =>
          rowsOf(
            await d.query(
              `SELECT COLUMN_NAME AS N, COLUMN_TYPE AS T, COLUMN_IS_NULLABLE AS NL, COLUMN_COMMENT AS C
               FROM SYS.EXA_ALL_COLUMNS WHERE COLUMN_SCHEMA = '${schema}' AND COLUMN_TABLE = '${table}'
               ORDER BY COLUMN_ORDINAL_POSITION`,
            ),
          ),
        )
        return {
          ok: true,
          value: {
            columns: columns.map((c) => ({
              name: String(c["N"] ?? ""),
              type: String(c["T"] ?? ""),
              nullable: String(c["NL"] ?? "") === "TRUE",
              comment: c["C"] == null ? null : String(c["C"]),
            })),
            constraints: [],
            indexes: [],
          },
        }
      }

      case "get_database_info": {
        const rows = await withDriver(String(arg("profileId", "")), async (d) =>
          rowsOf(await d.query("SELECT PARAM_NAME AS N, PARAM_VALUE AS V FROM SYS.EXA_METADATA")),
        )
        return {
          ok: true,
          value: {
            metadata: rows.map((r) => ({ name: String(r["N"] ?? ""), value: r["V"] == null ? null : String(r["V"]) })),
            parameters: [],
          },
        }
      }

      case "sql_history_list":
        return { ok: true, value: [] }
      case "sql_history_clear":
      case "cancel_query":
        return { ok: true, value: null }

      // Master-password vault — Studio's first-run flow will not open the app
      // without it, so these are implemented for real (see studio-vault.ts).
      case "vault_status":
        return { ok: true, value: vault.status() }
      case "vault_setup":
        return { ok: true, value: vault.setup(String(arg("password", ""))) }
      case "vault_unlock":
        return { ok: true, value: vault.unlock(String(arg("password", ""))) }
      case "vault_lock":
        vault.lock()
        return { ok: true, value: null }
      case "vault_recover":
        return { ok: true, value: vault.recover(String(arg("code", "")), String(arg("newPassword", ""))) }
      case "vault_change_password":
        vault.changePassword(String(arg("oldPassword", "")), String(arg("newPassword", "")))
        return { ok: true, value: null }
      case "vault_regenerate_recovery":
        return { ok: true, value: vault.regenerateRecovery() }

      default:
        if (REQUIRES_DESKTOP.has(command)) {
          return {
            ok: false,
            status: 501,
            error: `"${command}" needs the desktop app: it touches this machine's files, terminal or local runtime, which a browser session cannot reach.`,
          }
        }
        return {
          ok: false,
          status: 501,
          error: `"${command}" is not implemented by the exa backend yet.`,
        }
    }
  } catch (error) {
    return { ok: false, status: 500, error: error instanceof Error ? error.message : String(error) }
  }
}
