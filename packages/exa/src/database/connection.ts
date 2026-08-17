/**
 * Connecting to Exasol.
 *
 * The driver is bundled (pure JS over Exasol's WebSocket API), so a database
 * connection needs no Python, no MCP server and no extra install — which is
 * the difference between "install exa" giving you a working data agent and
 * giving you a chat box.
 *
 * Connection metadata is kept in the registry shared with Exasol Studio;
 * passwords are written beside it, one file per connection, 0600.
 */
import path from "path"
import { ExasolDriver } from "@exasol/exasol-driver-ts"
import { deleteSecret, readSecret, writeSecret } from "./secrets"
import {
  connectionId,
  parseRegistry,
  registryFile,
  upsert,
  remove as removeEntry,
  type ConnectionEntry,
  type Registry,
} from "./registry"

export type ConnectionTarget = {
  host: string
  port: number
  user: string
  password: string
  schema?: string
}

/**
 * Local Exasol deployments (Personal, the starter kit, containers) present
 * self-signed certificates, so certificate validation is relaxed for
 * loopback only — a remote host still gets full verification.
 */
function socketFactory(host: string) {
  const local = host === "127.0.0.1" || host === "localhost" || host === "::1"
  return (url: string) =>
    new WebSocket(url, local ? ({ tls: { rejectUnauthorized: false } } as never) : undefined) as never
}

export function createDriver(target: ConnectionTarget) {
  return new ExasolDriver(socketFactory(target.host) as never, {
    host: target.host,
    port: target.port,
    user: target.user,
    password: target.password,
    encryption: true,
  })
}

export type ProbeResult = { ok: true; version: string; schemas: string[] } | { ok: false; error: string }

/** Connect, confirm the credentials work, and report what is there. */
export async function probe(target: ConnectionTarget): Promise<ProbeResult> {
  const driver = createDriver(target)
  try {
    await driver.connect()
    const version = await driver
      .query("SELECT PARAM_VALUE AS V FROM SYS.EXA_METADATA WHERE PARAM_NAME = 'databaseProductVersion'")
      .then((r) => String((r.getRows()[0] as { V?: unknown })?.V ?? "unknown"))
      .catch(() => "unknown")
    const schemas = await driver
      .query("SELECT SCHEMA_NAME AS S FROM SYS.EXA_ALL_SCHEMAS ORDER BY 1")
      .then((r) => r.getRows().map((row) => String((row as { S?: unknown }).S ?? "")))
      .catch(() => [] as string[])
    return { ok: true, version, schemas: schemas.filter(Boolean) }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  } finally {
    await driver.close().catch(() => undefined)
  }
}

// ── the shared registry ────────────────────────────────────────────────────

async function readRegistry(): Promise<Registry> {
  const fs = await import("node:fs/promises")
  const text = await fs.readFile(registryFile(), "utf8").catch(() => undefined)
  return parseRegistry(text)
}

/** Read-merge-write: Studio writes this file too, so never overwrite blindly. */
async function writeRegistry(mutate: (current: Registry) => Registry): Promise<void> {
  const fs = await import("node:fs/promises")
  const file = registryFile()
  await fs.mkdir(path.dirname(file), { recursive: true })
  const next = mutate(await readRegistry())
  await fs.writeFile(file, JSON.stringify(next, null, 2) + "\n")
}

export async function listConnections(): Promise<ConnectionEntry[]> {
  return (await readRegistry()).connections
}

export async function saveConnection(
  target: ConnectionTarget,
  options: { name?: string; managed?: boolean; source?: ConnectionEntry["source"] } = {},
): Promise<ConnectionEntry> {
  const fs = await import("node:fs/promises")
  const id = connectionId(target.host, target.port, target.user)
  const entry: ConnectionEntry = {
    id,
    name: options.name?.trim() || `${target.user}@${target.host}:${target.port}`,
    host: target.host,
    port: target.port,
    user: target.user,
    schema: target.schema,
    managed: options.managed,
    source: options.source ?? "cli",
    createdAt: new Date().toISOString(),
  }
  await writeRegistry((current) => upsert(current, entry))

  // The registry never holds secrets: the password goes to the OS credential
  // store (or the 0600 file when the machine has none).
  await writeSecret(id, target.password)
  return entry
}

export async function forgetConnection(id: string): Promise<void> {
  await writeRegistry((current) => {
    const next = removeEntry(current, id)
    // Never leave the default pointing at a connection that is gone.
    return next.defaultId === id ? { ...next, defaultId: undefined } : next
  })
  await deleteSecret(id)
}

/** Make this connection the one used when a tool call names none. */
export async function setDefaultConnection(id: string): Promise<void> {
  await writeRegistry((current) => ({ ...current, defaultId: id }))
}

/** The connection id the user chose as default, if any. */
export async function defaultConnectionId(): Promise<string | undefined> {
  return (await readRegistry()).defaultId
}

export async function loadPassword(id: string): Promise<string | undefined> {
  return readSecret(id)
}

/**
 * The connection to use when none is named: the user's chosen default, else
 * the most recently registered one whose credential is available here.
 *
 * A registry entry can exist WITHOUT a shared credential — Exasol Studio
 * publishes metadata for remote databases but keeps their secrets in its
 * vault. Those entries are visible (so `exa connect --list` shows them) but
 * are not usable without a password, so they must not shadow a database that
 * is usable.
 *
 * Delegates to resolveConnection so there is exactly one definition of "the
 * default database" — two would drift, and the tools would disagree with
 * everything else about which database an unqualified question means.
 */
export async function activeConnection(): Promise<UsableConnection | undefined> {
  const resolved = await resolveConnection()
  return resolved.ok ? resolved.connection : undefined
}

export type UsableConnection = ConnectionEntry & { password: string }

/**
 * Every connection this machine can actually open, newest first.
 *
 * "Usable" means the credential is here. Exasol Studio publishes metadata for
 * databases whose secrets live in its own vault, so the registry can list
 * databases this machine cannot open; those are reported separately rather
 * than offered to the agent as if they worked.
 */
export async function usableConnections(): Promise<UsableConnection[]> {
  const all = await listConnections()
  const newestFirst = [...all].sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""))
  const out: UsableConnection[] = []
  for (const entry of newestFirst) {
    const password = await loadPassword(entry.id)
    if (password !== undefined && password !== "") out.push({ ...entry, password })
  }
  return out
}

/**
 * Match a connection by what a person would actually type.
 *
 * The agent picks a database by name, so matching has to be forgiving: the id,
 * the display name, `host:port`, or an unambiguous partial name. Ambiguity is
 * an error rather than a guess — silently querying the wrong database returns
 * a plausible number from the wrong place, which is the worst outcome
 * available here.
 */
export function matchConnection<T extends ConnectionEntry>(
  connections: T[],
  wanted: string,
): { ok: true; connection: T } | { ok: false; reason: "none" | "ambiguous"; candidates: T[] } {
  const needle = wanted.trim().toLowerCase()
  const exact = connections.filter(
    (c) =>
      c.id.toLowerCase() === needle ||
      c.name.toLowerCase() === needle ||
      `${c.host}:${c.port}`.toLowerCase() === needle,
  )
  if (exact.length === 1) return { ok: true, connection: exact[0]! }
  if (exact.length > 1) return { ok: false, reason: "ambiguous", candidates: exact }

  const partial = connections.filter(
    (c) => c.name.toLowerCase().includes(needle) || c.id.toLowerCase().includes(needle),
  )
  if (partial.length === 1) return { ok: true, connection: partial[0]! }
  if (partial.length > 1) return { ok: false, reason: "ambiguous", candidates: partial }
  return { ok: false, reason: "none", candidates: connections }
}

/**
 * The connection a tool call should use: the one named, or the default when no
 * name was given.
 *
 * Returning a message rather than throwing keeps the failure inside the tool
 * result, where the agent can read it and correct itself — a thrown error just
 * ends the turn.
 */
export async function resolveConnection(
  wanted?: string,
): Promise<{ ok: true; connection: UsableConnection } | { ok: false; message: string }> {
  const usable = await usableConnections()
  if (usable.length === 0) {
    const missing = await connectionsMissingCredentials()
    if (missing.length > 0) {
      return {
        ok: false,
        message:
          `No database can be opened here. ${missing.length} registered ` +
          `(${missing.map((m) => m.name).join(", ")}) but their credentials are not on this machine. ` +
          "Run `exa connect` to add one with its password.",
      }
    }
    return { ok: false, message: NO_CONNECTION }
  }

  if (!wanted) {
    // An explicitly chosen default wins; otherwise the most recently
    // registered, which is the right answer when there is only one.
    const registry = await readRegistry()
    const chosen = registry.defaultId && usable.find((c) => c.id === registry.defaultId)
    return { ok: true, connection: chosen || usable[0]! }
  }

  const found = matchConnection(usable, wanted)
  if (found.ok) return { ok: true, connection: found.connection }
  const names = usable.map((c) => c.name).join(", ")
  return {
    ok: false,
    message:
      found.reason === "ambiguous"
        ? `"${wanted}" matches more than one database (${found.candidates.map((c) => c.name).join(", ")}). Use the full name.`
        : `No connected database matches "${wanted}". Connected: ${names}.`,
  }
}

export const NO_CONNECTION =
  "No database is connected. Run `exa connect` (or /connect-db in a session) to attach one, then try again."

/** Registry entries with no credential on this machine, for clear messaging. */
export async function connectionsMissingCredentials(): Promise<ConnectionEntry[]> {
  const all = await listConnections()
  const missing: ConnectionEntry[] = []
  for (const entry of all) {
    const password = await loadPassword(entry.id)
    if (password === undefined || password === "") missing.push(entry)
  }
  return missing
}
