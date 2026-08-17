import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { NO_CONNECTION, createDriver, resolveConnection, usableConnections } from "../database/connection"
import { classifySql, describeOperation, type SqlOps } from "../database/sql-ops"

/**
 * Native Exasol tools.
 *
 * These exist so the agent can query the user's database with nothing
 * installed but exa itself. Two things live here rather than in the prompt:
 *
 *  - The read-only default is ENFORCED, not requested. A statement outside
 *    the granted operation classes is refused by this code, so no amount of
 *    clever prompting gets an UPDATE through when the user granted none.
 *  - Results are truncated to a row cap, because an agent that pulls a
 *    million rows into its context is useless and expensive.
 *
 * Every tool takes an optional `database`, so one session can work across all
 * the databases the user has connected. Omitting it uses the default, which is
 * what a single-database setup always gets.
 */

/** The database argument, worded the same way on every tool. */
const DatabaseArg = Schema.optional(Schema.String).annotate({
  description:
    "Which connected database to use — a name from exasol_databases. Omit when only one is connected, or to use the default.",
})

async function withDriver<T>(
  database: string | undefined,
  fn: (driver: ReturnType<typeof createDriver>) => Promise<T>,
): Promise<T | string> {
  const resolved = await resolveConnection(database)
  if (!resolved.ok) return resolved.message
  const conn = resolved.connection
  const driver = createDriver(conn)
  try {
    await driver.connect()
    return await fn(driver)
  } catch (err) {
    // Name the database in the error: with several connected, "Exasol error"
    // alone leaves the agent unable to tell which one failed.
    return `Exasol error on ${conn.name}: ${err instanceof Error ? err.message : String(err)}`
  } finally {
    await driver.close().catch(() => undefined)
  }
}

function rowsToText(rows: unknown[], limit: number): string {
  if (rows.length === 0) return "(no rows)"
  const shown = rows.slice(0, limit)
  const header = Object.keys(shown[0] as Record<string, unknown>)
  const lines = [header.join(" | ")]
  for (const row of shown) {
    lines.push(header.map((h) => String((row as Record<string, unknown>)[h] ?? "")).join(" | "))
  }
  if (rows.length > limit) lines.push(`… ${rows.length - limit} more rows (refine the query to see them)`)
  return lines.join("\n")
}

export const DatabasesParameters = Schema.Struct({})

export const ExasolDatabasesTool = Tool.define<typeof DatabasesParameters, {}, never>(
  "exasol_databases",
  Effect.gen(function* () {
    return {
      description:
        "List the Exasol databases connected on this machine. Call this first when a question spans more than one source, then pass a name as `database` to the other tools.",
      parameters: DatabasesParameters,
      execute: () =>
        Effect.promise(async () => {
          const usable = await usableConnections()
          if (usable.length === 0) {
            return { output: NO_CONNECTION, title: "no databases", metadata: {} }
          }
          const lines = usable.map((c, i) => {
            const where = `${c.host}:${c.port} as ${c.user}`
            return `${c.name} — ${where}${i === 0 ? "  (default)" : ""}`
          })
          return {
            output: lines.join("\n"),
            title: `${usable.length} database${usable.length === 1 ? "" : "s"}`,
            metadata: {},
          }
        }),
    }
  }),
)

export const SchemasParameters = Schema.Struct({ database: DatabaseArg })

export const ExasolSchemasTool = Tool.define<typeof SchemasParameters, {}, never>(
  "exasol_schemas",
  Effect.gen(function* () {
    return {
      description:
        "List the schemas in a connected Exasol database. Use this before writing SQL so table names come from the database, not a guess.",
      parameters: SchemasParameters,
      execute: (params: Schema.Schema.Type<typeof SchemasParameters>) =>
        Effect.promise(async () => {
          const out = await withDriver(params.database, async (driver) => {
            const r = await driver.query("SELECT SCHEMA_NAME AS S FROM SYS.EXA_ALL_SCHEMAS ORDER BY 1")
            return rowsToText(r.getRows(), 200)
          })
          return { output: String(out), title: "schemas", metadata: {} }
        }),
    }
  }),
)

export const TablesParameters = Schema.Struct({
  schema: Schema.String.annotate({ description: "Schema name (case-insensitive)" }),
  database: DatabaseArg,
})

export const ExasolTablesTool = Tool.define<typeof TablesParameters, {}, never>(
  "exasol_tables",
  Effect.gen(function* () {
    return {
      description: "List tables and views in a schema of a connected Exasol database, with row counts where known.",
      parameters: TablesParameters,
      execute: (params: Schema.Schema.Type<typeof TablesParameters>) =>
        Effect.promise(async () => {
          const out = await withDriver(params.database, async (driver) => {
            const schema = params.schema.toUpperCase().replaceAll("'", "''")
            const r = await driver.query(
              `SELECT TABLE_NAME AS NAME, TABLE_ROW_COUNT AS ROWS FROM SYS.EXA_ALL_TABLES WHERE TABLE_SCHEMA = '${schema}'
               UNION ALL
               SELECT VIEW_NAME AS NAME, NULL AS ROWS FROM SYS.EXA_ALL_VIEWS WHERE VIEW_SCHEMA = '${schema}'
               ORDER BY 1`,
            )
            return rowsToText(r.getRows(), 300)
          })
          return { output: String(out), title: params.schema, metadata: {} }
        }),
    }
  }),
)

export const DescribeParameters = Schema.Struct({
  schema: Schema.String.annotate({ description: "Schema name" }),
  table: Schema.String.annotate({ description: "Table or view name" }),
  database: DatabaseArg,
})

export const ExasolDescribeTool = Tool.define<typeof DescribeParameters, {}, never>(
  "exasol_describe",
  Effect.gen(function* () {
    return {
      description: "Show the columns and types of a table or view, so SQL uses real column names.",
      parameters: DescribeParameters,
      execute: (params: Schema.Schema.Type<typeof DescribeParameters>) =>
        Effect.promise(async () => {
          const out = await withDriver(params.database, async (driver) => {
            const schema = params.schema.toUpperCase().replaceAll("'", "''")
            const table = params.table.toUpperCase().replaceAll("'", "''")
            const r = await driver.query(
              `SELECT COLUMN_NAME AS NAME, COLUMN_TYPE AS TYPE, COLUMN_IS_NULLABLE AS NULLABLE
               FROM SYS.EXA_ALL_COLUMNS WHERE COLUMN_SCHEMA = '${schema}' AND COLUMN_TABLE = '${table}'
               ORDER BY COLUMN_ORDINAL_POSITION`,
            )
            return rowsToText(r.getRows(), 500)
          })
          return { output: String(out), title: `${params.schema}.${params.table}`, metadata: {} }
        }),
    }
  }),
)

export const QueryParameters = Schema.Struct({
  sql: Schema.String.annotate({ description: "The SQL to run against the connected Exasol database" }),
  limit: Schema.optional(Schema.Finite).annotate({ description: "Max rows to return (default 100)" }),
  database: DatabaseArg,
})

export const ExasolQueryTool = Tool.define<typeof QueryParameters, { operation: string }, never>(
  "exasol_query",
  Effect.gen(function* () {
    return {
      description:
        "Run SQL against a connected Exasol database. One statement runs against one database — Exasol cannot join across separate databases, so to combine sources, query each and combine the results yourself. Reads are always allowed; anything that writes or changes structure is refused unless the user granted that operation class (`exa ops`). Exasol notes: identifiers fold to uppercase unless quoted, and paging uses LIMIT n.",
      parameters: QueryParameters,
      execute: (params: Schema.Schema.Type<typeof QueryParameters>) =>
        Effect.promise(async () => {
          const granted = await readGrantedOps()
          const op = classifySql(params.sql)
          if (op && !granted.includes(op)) {
            return {
              output: `Refused: this statement is ${describeOperation(op)}, which is not granted. The user can allow it with \`exa ops grant ${op}\` (or /ops in a session). Reads are always available.`,
              title: "refused",
              metadata: { operation: op },
            }
          }
          const limit = Number.isFinite(params.limit) ? Math.max(1, Math.floor(params.limit!)) : 100
          const out = await withDriver(params.database, async (driver) => {
            // The driver splits these: query() returns a result set and REJECTS
            // a statement that has none ("Please use method execute instead"),
            // while execute() returns the affected row count. Sending a granted
            // INSERT or CREATE through query() therefore failed at the driver
            // even though the ops check had passed. classifySql already
            // distinguishes them — reads classify as undefined.
            if (op) {
              const affected = await driver.execute(params.sql)
              return Number.isFinite(affected)
                ? `OK — ${affected} row${affected === 1 ? "" : "s"} affected`
                : "OK"
            }
            const r = await driver.query(params.sql)
            const rows = typeof (r as { getRows?: unknown }).getRows === "function" ? r.getRows() : []
            return rowsToText(rows, limit)
          })
          return { output: String(out), title: op ?? "select", metadata: { operation: op ?? "read" } }
        }),
    }
  }),
)

/** Operation classes the user granted, read from the exa agent's config. */
async function readGrantedOps(): Promise<SqlOps[]> {
  const { Global } = await import("@exa/core/global")
  const fs = await import("node:fs/promises")
  const path = await import("node:path")
  for (const name of ["exa.json", "exa.jsonc"]) {
    try {
      const text = await fs.readFile(path.join(Global.Path.config, name), "utf8")
      const parsed = JSON.parse(text.replace(/^\s*\/\/.*$/gm, "")) as {
        agent?: { exa?: { options?: { sqlOps?: string[] } } }
      }
      const ops = parsed.agent?.exa?.options?.sqlOps
      if (Array.isArray(ops)) return ops as SqlOps[]
    } catch {
      /* absent or unparseable — treat as no grants */
    }
  }
  return []
}
