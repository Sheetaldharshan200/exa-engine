/**
 * The shared connection registry.
 *
 * Exa the CLI and Exasol Studio are separate programs that must agree about
 * which databases exist: a database installed or connected in one has to show
 * up in the other. Neither owns the list, so it lives outside both of their
 * private directories, in a plain file both read and write:
 *
 *   ~/.exasol/connections.json      (override with EXASOL_CONNECTIONS_FILE)
 *
 * The file carries connection METADATA only. Passwords live beside it in
 * `credentials/<id>` with 0600 permissions, the same shape the Exasol starter
 * kit already uses — so a registry file can be copied or inspected without
 * carrying secrets, and a secret can be replaced without rewriting the list.
 */
import path from "path"
import os from "os"

export type ConnectionSource = "cli" | "studio" | "manual"

export type ConnectionEntry = {
  /** Stable id; also the credential filename. */
  id: string
  name: string
  host: string
  port: number
  user: string
  schema?: string
  /** True for a database this tooling deployed (and may manage/remove). */
  managed?: boolean
  /** Which program registered it — informational, never a filter. */
  source?: ConnectionSource
  createdAt?: string
}

export type Registry = { version: 1; connections: ConnectionEntry[] }

export const EMPTY: Registry = { version: 1, connections: [] }

export function registryFile(env: Record<string, string | undefined> = process.env): string {
  const override = env.EXASOL_CONNECTIONS_FILE?.trim()
  if (override) return override
  const home = env.HOME ?? env.USERPROFILE ?? os.homedir()
  return path.join(home, ".exasol", "connections.json")
}

export function credentialFile(id: string, env: Record<string, string | undefined> = process.env): string {
  return path.join(path.dirname(registryFile(env)), "credentials", id)
}

/**
 * Parse a registry file's contents. Anything unreadable yields an EMPTY
 * registry rather than an error: a corrupt shared file must not stop the CLI
 * from starting, and the next write repairs it.
 */
export function parseRegistry(text: string | undefined): Registry {
  if (!text) return { ...EMPTY, connections: [] }
  try {
    const raw = JSON.parse(text) as Partial<Registry>
    if (!raw || !Array.isArray(raw.connections)) return { ...EMPTY, connections: [] }
    const connections = raw.connections.filter(
      (c): c is ConnectionEntry =>
        !!c && typeof c.id === "string" && typeof c.host === "string" && typeof c.port === "number",
    )
    return { version: 1, connections }
  } catch {
    return { ...EMPTY, connections: [] }
  }
}

/**
 * Merge an entry into the list, replacing any entry with the same id.
 *
 * Both programs write this file, so a write is always "read, merge, write" —
 * never a blind overwrite, or one of them silently drops the other's
 * connections.
 */
export function upsert(registry: Registry, entry: ConnectionEntry): Registry {
  const rest = registry.connections.filter((c) => c.id !== entry.id)
  return { version: 1, connections: [...rest, entry] }
}

export function remove(registry: Registry, id: string): Registry {
  return { version: 1, connections: registry.connections.filter((c) => c.id !== id) }
}

/** A stable id from the connection target, so both programs derive the same one. */
export function connectionId(host: string, port: number, user: string): string {
  return `${host}_${port}_${user}`.toLowerCase().replace(/[^a-z0-9_.-]/g, "-")
}

/** Parse `exasol://user@host:8563/schema` (password never in the URL). */
export function parseDsn(dsn: string): { host: string; port: number; user: string; schema?: string } | undefined {
  try {
    const url = new URL(dsn)
    if (url.protocol !== "exasol:") return undefined
    const host = url.hostname
    if (!host) return undefined
    const port = url.port ? Number(url.port) : 8563
    if (!Number.isFinite(port) || port <= 0) return undefined
    const schema = url.pathname.replace(/^\//, "") || undefined
    return { host, port, user: decodeURIComponent(url.username) || "sys", schema }
  } catch {
    return undefined
  }
}
