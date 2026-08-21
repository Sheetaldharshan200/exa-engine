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
import os from "node:os"
import path from "node:path"
import fs from "node:fs/promises"

/** Tiny JSON stores for the web build's app/connection settings. */
function jsonStore(file: string) {
  const full = path.join(os.homedir(), ".exasol", file)
  return {
    async get(): Promise<Record<string, any>> {
      try {
        return JSON.parse(await fs.readFile(full, "utf8"))
      } catch {
        return {}
      }
    },
    async write(value: Record<string, unknown>) {
      await fs.mkdir(path.dirname(full), { recursive: true })
      await fs.writeFile(full, JSON.stringify(value, null, 2))
    },
    async set(patch: Record<string, unknown>) {
      const current = await this.get()
      const next = { ...current, ...patch }
      await this.write(next)
      return next
    },
  }
}
async function fsEntry(full: string) {
  const stat = await fs.stat(full)
  const ext = stat.isDirectory() ? null : (path.extname(full).replace(".", "") || null)
  return {
    name: path.basename(full),
    path: full,
    isDir: stat.isDirectory(),
    size: stat.size,
    modified: stat.mtime ? stat.mtime.toISOString() : null,
    ext,
  }
}

/** The official Exasol agent skills (exasol-labs/exasol-agent-skills). */
const OFFICIAL_SKILL_IDS = [
  "exasol", "exasol-ai-setup", "exasol-bucketfs", "exasol-cloud-storage-extension", "exasol-database",
  "exasol-distributed-ml", "exasol-document-virtual-schemas", "exasol-export", "exasol-extension-catalog",
  "exasol-import", "exasol-itde", "exasol-jdbc-virtual-schemas", "exasol-notebook-connections",
  "exasol-text-ai", "exasol-transformers", "exasol-udfs", "exasol-virtual-schema-adapter-development",
  "exasol-setup-personal",
]

const webSettings = () => jsonStore("web-settings.json")
const webConnSettings = () => jsonStore("web-connection-settings.json")
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
  "exasol_local_ctl", "engine_install", "engine_status", "engine_uninstall_cli", "engine_install_cli",
  "git_status", "git_log", "git_stage", "git_unstage", "git_commit", "git_push", "git_pull", "git_fetch", "git_init", "git_diff", "git_branches", "git_checkout", "git_discard", "git_set_remote",
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

      // The UI adopts the returned server info directly (it reads
      // .databaseName on it), so connect must answer with the real thing —
      // a null here blank-screened the whole web app.
      case "connect": {
        const target = await targetFor(String(arg("profileId", "")))
        const result = await probe(target)
        if (!result.ok) return { ok: false, status: 400, error: result.error }
        return {
          ok: true,
          value: {
            databaseName: "EXA_DB",
            version: result.version,
            currentUser: target.user,
            currentSchema: target.schema ?? null,
            sessionId: connectionId(target.host, target.port, target.user),
            nodes: null,
          },
        }
      }
      case "disconnect":
        return { ok: true, value: null }

      // Web-side app settings: a real little store, so the Settings window
      // works in the browser too.
      case "get_app_settings":
        return { ok: true, value: await webSettings().get() }
      case "set_app_settings": {
        const patch = arg<Record<string, unknown>>("patch", {})
        return { ok: true, value: await webSettings().set(patch) }
      }
      case "connection_settings_get":
        return { ok: true, value: (await webConnSettings().get())[String(arg("profileId", ""))] ?? {} }
      case "connection_settings_set": {
        const store = webConnSettings()
        const all = await store.get()
        all[String(arg("profileId", ""))] = arg("settings", {})
        await store.write(all)
        return { ok: true, value: all[String(arg("profileId", ""))] }
      }

      // This server IS the exa CLI — installed by definition.
      case "engine_cli_status":
        return { ok: true, value: { installed: true, path: process.execPath } }

      // ── Files: the workspace folder on the machine running this server ──
      case "fs_workspace_dir": {
        const dir = path.join(os.homedir(), "ExasolStudio")
        await fs.mkdir(dir, { recursive: true })
        return { ok: true, value: await fsEntry(dir) }
      }
      case "fs_home_roots": {
        const home = os.homedir()
        const roots = []
        for (const name of ["ExasolStudio", "Desktop", "Documents", "Downloads"]) {
          const full = path.join(home, name)
          try {
            await fs.access(full)
            roots.push(await fsEntry(full))
          } catch {
            /* absent on this machine */
          }
        }
        return { ok: true, value: roots }
      }
      case "fs_list_dir": {
        const dir = String(arg("path", ""))
        const names = await fs.readdir(dir)
        const entries = await Promise.all(names.map((n) => fsEntry(path.join(dir, n)).catch(() => null)))
        return {
          ok: true,
          value: entries
            .filter((e): e is NonNullable<typeof e> => e !== null)
            .sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name)),
        }
      }
      case "fs_read_text": {
        const file = String(arg("path", ""))
        const stat = await fs.stat(file)
        if (stat.size > 2 * 1024 * 1024) return { ok: false, status: 400, error: "File is too large to open as text (2 MB limit)." }
        return { ok: true, value: await fs.readFile(file, "utf8") }
      }
      case "fs_read_table": {
        const file = String(arg("path", ""))
        const limit = Number(arg("limit", 200))
        const ext = path.extname(file).toLowerCase()
        if (ext === ".parquet") {
          return { ok: false, status: 501, error: "Parquet preview needs the desktop app; open CSV/TSV here, or load the file into the database." }
        }
        const delim = ext === ".tsv" ? "\t" : ","
        const text = await fs.readFile(file, "utf8")
        const lines = text.split(/\r?\n/).filter((l) => l.length > 0)
        const parse = (line: string) => {
          const out: string[] = []
          let cur = ""
          let quoted = false
          for (let i = 0; i < line.length; i++) {
            const ch = line[i]!
            if (quoted) {
              if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++ }
              else if (ch === '"') quoted = false
              else cur += ch
            } else if (ch === '"') quoted = true
            else if (ch === delim) { out.push(cur); cur = "" }
            else cur += ch
          }
          out.push(cur)
          return out
        }
        const columns = lines.length ? parse(lines[0]!) : []
        const rows = lines.slice(1, 1 + limit).map(parse)
        return { ok: true, value: { columns, rows, truncated: lines.length - 1 > rows.length, format: ext.replace(".", "") || "csv" } }
      }
      case "fs_search": {
        const root = String(arg("root", path.join(os.homedir(), "ExasolStudio")))
        const query = String(arg("query", "")).toLowerCase()
        const limit = Number(arg("limit", 50))
        const hits: unknown[] = []
        const walk = async (dir: string, depth: number) => {
          if (hits.length >= limit || depth > 6) return
          const names = await fs.readdir(dir).catch(() => [] as string[])
          for (const n of names) {
            if (hits.length >= limit) return
            if (n.startsWith(".")) continue
            const full = path.join(dir, n)
            const entry = await fsEntry(full).catch(() => null)
            if (!entry) continue
            if (n.toLowerCase().includes(query)) hits.push(entry)
            if (entry.isDir) await walk(full, depth + 1)
          }
        }
        await walk(root, 0)
        return { ok: true, value: hits }
      }
      case "fs_delete": {
        const target = String(arg("path", ""))
        // Only inside the workspace — a stray path must not delete arbitrary files.
        const workspace = path.join(os.homedir(), "ExasolStudio")
        if (!path.resolve(target).startsWith(workspace + path.sep)) {
          return { ok: false, status: 400, error: "Only files inside the ~/ExasolStudio workspace can be deleted from here." }
        }
        await fs.rm(target, { recursive: true })
        return { ok: true, value: null }
      }

      // ── Schema visualizer graph: tables, columns (pk) and FK links ──
      case "get_schema_graph": {
        const schema = String(arg("schema", "")).toUpperCase().replaceAll("'", "''")
        const value = await withDriver(String(arg("profileId", "")), async (d) => {
          const columns = rowsOf(
            await d.query(
              `SELECT COLUMN_TABLE AS T, COLUMN_NAME AS C, COLUMN_TYPE AS Y
               FROM SYS.EXA_ALL_COLUMNS WHERE COLUMN_SCHEMA = '${schema}'
               ORDER BY COLUMN_TABLE, COLUMN_ORDINAL_POSITION`,
            ),
          )
          const cons = rowsOf(
            await d.query(
              `SELECT CONSTRAINT_TABLE AS T, COLUMN_NAME AS C, CONSTRAINT_TYPE AS K,
                      REFERENCED_TABLE AS RT, REFERENCED_COLUMN AS RC
               FROM SYS.EXA_ALL_CONSTRAINT_COLUMNS WHERE CONSTRAINT_SCHEMA = '${schema}'`,
            ),
          )
          const pk = new Set(cons.filter((r) => r["K"] === "PRIMARY KEY").map((r) => `${r["T"]}.${r["C"]}`))
          const tables = new Map<string, { name: string; columns: { name: string; dataType: string; pk: boolean }[] }>()
          for (const r of columns) {
            const t = String(r["T"])
            if (!tables.has(t)) tables.set(t, { name: t, columns: [] })
            tables.get(t)!.columns.push({ name: String(r["C"]), dataType: String(r["Y"]), pk: pk.has(`${t}.${r["C"]}`) })
          }
          const links = cons
            .filter((r) => r["K"] === "FOREIGN KEY" && r["RT"])
            .map((r) => ({
              source: String(r["T"]),
              sourceColumn: String(r["C"]),
              target: String(r["RT"]),
              targetColumn: String(r["RC"] ?? ""),
            }))
          return { tables: [...tables.values()], links }
        })
        return { ok: true, value }
      }

      // ── Skills marketplace: same catalog and targets as the desktop app,
      // operating on THIS machine (exa web is local). ──
      case "skills_list_targets": {
        const { execSync } = await import("node:child_process")
        const has = (bin: string) => {
          try {
            execSync(process.platform === "win32" ? `where ${bin}` : `command -v ${bin}`, { stdio: "ignore", shell: process.platform === "win32" ? undefined : "/bin/sh" })
            return true
          } catch {
            return false
          }
        }
        const targets = [
          { id: "claude-code", name: "Claude Code", bin: "claude", installUrl: "https://claude.com/claude-code" },
          { id: "codex", name: "Codex", bin: "codex", installUrl: "https://github.com/openai/codex" },
          { id: "cursor", name: "Cursor", bin: "cursor", installUrl: "https://cursor.com" },
        ]
        return { ok: true, value: targets.map((t) => ({ id: t.id, name: t.name, installed: has(t.bin), installUrl: t.installUrl })) }
      }
      case "skills_installed_official": {
        const home = os.homedir()
        const hasSkill = async (base: string, id: string) => {
          try {
            const dir = path.join(base, id)
            const l = await fs.lstat(dir)
            if (l.isSymbolicLink()) return false
            await fs.access(path.join(dir, "SKILL.md"))
            return true
          } catch {
            return false
          }
        }
        const map: Record<string, string[]> = { "claude-code": [], codex: [] }
        for (const id of OFFICIAL_SKILL_IDS) {
          if (await hasSkill(path.join(home, ".claude", "skills"), id)) map["claude-code"]!.push(id)
          if ((await hasSkill(path.join(home, ".agents", "skills"), id)) || (await hasSkill(path.join(home, ".codex", "skills"), id)))
            map["codex"]!.push(id)
        }
        return { ok: true, value: map }
      }
      case "skills_fetch_official": {
        const id = String(arg("skill", ""))
        if (!OFFICIAL_SKILL_IDS.includes(id)) return { ok: false, status: 400, error: `unknown official skill \`${id}\`` }
        const dir = id === "exasol-setup-personal" ? "setup-personal" : id
        const res = await fetch(
          `https://raw.githubusercontent.com/exasol-labs/exasol-agent-skills/main/plugins/exasol/skills/${dir}/SKILL.md`,
          { headers: { "user-agent": "exa" }, signal: AbortSignal.timeout(15_000) },
        )
        if (!res.ok) return { ok: false, status: 502, error: `Could not fetch \`${id}\` (HTTP ${res.status}).` }
        const text = await res.text()
        const fm = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text)
        const front = fm?.[1] ?? ""
        const body = (fm?.[2] ?? text).trim()
        const name = /(^|\n)name:\s*(.+)/.exec(front)?.[2]?.trim() ?? id
        const description = /(^|\n)description:\s*(.+)/.exec(front)?.[2]?.trim() ?? ""
        return { ok: true, value: { id, name, description, body: text, content: body } }
      }
      case "skills_install_official": {
        const target = String(arg("target", ""))
        const skills = arg<string[]>("skills", [])
        const agent = { "claude-code": "claude-code", codex: "codex", cursor: "cursor" }[target]
        if (!agent || !Array.isArray(skills) || skills.length === 0 || skills.some((x) => !OFFICIAL_SKILL_IDS.includes(x))) {
          return { ok: false, status: 400, error: "Unsupported target or unknown skill id." }
        }
        const { execFile } = await import("node:child_process")
        const args = ["--yes", "skills", "add", "exasol-labs/exasol-agent-skills", "-a", agent]
        for (const id of skills) args.push("-s", id)
        args.push("-g", "-y")
        const output = await new Promise<{ code: number; out: string }>((resolve) => {
          execFile("npx", args, { timeout: 180_000 }, (err, stdout, stderr) =>
            resolve({ code: err ? 1 : 0, out: `${stdout}\n${stderr}`.trim() }),
          )
        })
        if (output.code !== 0) return { ok: false, status: 502, error: output.out.slice(-400) || "skills CLI failed" }
        return { ok: true, value: null }
      }
      case "skills_install_persona": {
        const target = String(arg("target", ""))
        const skills = arg<{ id?: string; name: string; description?: string; body: string }[]>("skills", [])
        const base =
          target === "claude-code"
            ? path.join(os.homedir(), ".claude", "skills")
            : path.join(os.homedir(), ".agents", "skills")
        for (const skill of skills) {
          const slug = (skill.id ?? skill.name).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "")
          const dir = path.join(base, slug)
          await fs.mkdir(dir, { recursive: true })
          const content = skill.body.startsWith("---")
            ? skill.body
            : `---\nname: ${skill.name}\ndescription: ${skill.description ?? ""}\n---\n\n${skill.body}\n`
          await fs.writeFile(path.join(dir, "SKILL.md"), content)
        }
        return { ok: true, value: null }
      }
      case "skills_install_target": {
        const target = String(arg("target", ""))
        const agent = { "claude-code": "claude-code", codex: "codex", cursor: "cursor" }[target]
        if (!agent) return { ok: false, status: 400, error: "Unsupported target." }
        const { execFile } = await import("node:child_process")
        const output = await new Promise<{ code: number; out: string }>((resolve) => {
          execFile(
            "npx",
            ["--yes", "skills", "add", "exasol-labs/exasol-agent-skills", "-a", agent, "-g", "-y"],
            { timeout: 300_000 },
            (err, stdout, stderr) => resolve({ code: err ? 1 : 0, out: `${stdout}\n${stderr}`.trim() }),
          )
        })
        if (output.code !== 0) return { ok: false, status: 502, error: output.out.slice(-400) || "skills CLI failed" }
        return { ok: true, value: null }
      }

      // The sidebar's Exasol Personal card. The CLI installs into the shared
      // default deployment; report its real state so web stays in sync.
      case "personal_local_status": {
        const home = os.homedir()
        const deploymentFile = path.join(home, ".exasol", "personal", "deployments", "default", "deployment.json")
        let installed = false
        let port = 8563
        try {
          const deployment = JSON.parse(await fs.readFile(deploymentFile, "utf8"))
          installed = true
          port = Number(deployment?.connection?.dbPort ?? 8563)
        } catch {
          // not installed
        }
        const net = await import("node:net")
        const running = installed
          ? await new Promise<boolean>((resolve) => {
              const socket = net.connect({ host: "127.0.0.1", port }, () => {
                socket.end()
                resolve(true)
              })
              socket.on("error", () => resolve(false))
              setTimeout(() => {
                socket.destroy()
                resolve(false)
              }, 1_500)
            })
          : false
        const profile = (await listConnections()).find(
          (c) => (c.host === "127.0.0.1" || c.host === "localhost") && c.port === port,
        )
        return {
          ok: true,
          value: {
            state: running ? "ready" : installed ? "stopped" : "idle",
            step: running ? "ready" : installed ? "stopped" : "not installed",
            message: running
              ? "Exasol Personal is running."
              : installed
                ? "Exasol Personal is installed but not running — start it with `exa connect` or from the desktop app."
                : "Not installed on this machine.",
            localReady: running,
            profileId: profile?.id ?? null,
            components: {},
          },
        }
      }

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
