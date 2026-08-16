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
  await writeRegistry((current) => removeEntry(current, id))
  await deleteSecret(id)
}

export async function loadPassword(id: string): Promise<string | undefined> {
  return readSecret(id)
}

/**
 * The connection the agent should use: the newest one whose credential is
 * available here.
 *
 * A registry entry can exist WITHOUT a shared credential — Exasol Studio
 * publishes metadata for remote databases but keeps their secrets in its
 * vault. Those entries are visible (so `exa connect --list` shows them) but
 * are not usable without a password, so they must not shadow a database that
 * is usable.
 */
export async function activeConnection(): Promise<(ConnectionEntry & { password: string }) | undefined> {
  const all = await listConnections()
  const newestFirst = [...all].sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""))
  for (const entry of newestFirst) {
    const password = await loadPassword(entry.id)
    if (password !== undefined && password !== "") return { ...entry, password }
  }
  return undefined
}

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
