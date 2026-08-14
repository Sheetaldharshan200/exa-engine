/**
 * Local backups of session history, with optional sync to storage the user
 * controls.
 *
 * Why this exists: sessions live in the data directory, which is one `rm -rf`,
 * one disk failure or one migration away from gone. A backup is a single
 * tar.gz bundle of the session store plus the config, written on a debounce
 * after activity, pruned to a retention count, and optionally handed to a
 * command of the user's choosing (`aws s3 cp`, `rclone copy`, a script) so it
 * can land in storage we never see.
 *
 * Credentials are EXCLUDED by default: a bundle should be safe to drop in
 * third-party storage without leaking provider keys.
 */
import path from "path"

export type BackupConfig = {
  enabled?: boolean
  directory?: string
  retain?: number
  debounceSeconds?: number
  includeCredentials?: boolean
  sync?: { command?: string[] }
}

export type ResolvedBackup = {
  enabled: boolean
  directory: string
  retain: number
  debounceMs: number
  includeCredentials: boolean
  syncCommand: string[] | undefined
}

const DEFAULTS = { retain: 10, debounceSeconds: 60 }

/** Apply defaults. `dataDir` supplies the default location. */
export function resolveBackup(config: BackupConfig | undefined, dataDir: string): ResolvedBackup {
  const retain = Number.isFinite(config?.retain) ? Math.max(1, Math.floor(config!.retain!)) : DEFAULTS.retain
  const debounce = Number.isFinite(config?.debounceSeconds)
    ? Math.max(1, Math.floor(config!.debounceSeconds!))
    : DEFAULTS.debounceSeconds
  const command = config?.sync?.command?.map((part) => (typeof part === "string" ? part.trim() : "")).filter((part) => part.length > 0)
  return {
    enabled: config?.enabled ?? true,
    directory: config?.directory?.trim() || path.join(dataDir, "backup"),
    retain,
    debounceMs: debounce * 1000,
    includeCredentials: config?.includeCredentials ?? false,
    syncCommand: command && command.length > 0 ? command : undefined,
  }
}

const PREFIX = "exa-backup-"
const SUFFIX = ".tar.gz"

/** Bundle name for an instant: sortable, filesystem-safe, no collisions. */
export function bundleName(at: Date): string {
  const iso = at.toISOString().replace(/[:.]/g, "-").replace("Z", "")
  return `${PREFIX}${iso}${SUFFIX}`
}

/** True for names this module produced (so pruning never touches other files). */
export function isBundle(name: string): boolean {
  return name.startsWith(PREFIX) && name.endsWith(SUFFIX)
}

/**
 * Which bundles to delete so at most `retain` newest remain. Sorting is by
 * name, which is chronological by construction — no stat() calls, and a clock
 * that jumps cannot make an older bundle outrank a newer one within a run.
 */
export function pruneList(names: string[], retain: number): string[] {
  const bundles = names.filter(isBundle).sort()
  const excess = bundles.length - Math.max(1, retain)
  return excess > 0 ? bundles.slice(0, excess) : []
}

/**
 * Paths inside the data directory that belong in a bundle. Credentials are
 * opt-in; everything else is session history and configuration.
 *
 * The SQLite database is NOT listed here: copying a live database file is
 * unsafe (its WAL lives beside it, so a plain copy can restore a database
 * that SQLite then refuses to open — observed 2026-08-14). It is snapshotted
 * separately with VACUUM INTO, which writes a self-contained file.
 */
export function bundlePaths(includeCredentials: boolean): string[] {
  const base = ["storage", "exa.json", "exa.jsonc"]
  return includeCredentials ? [...base, "auth.json"] : base
}

/** The database file and the sidecars that must never outlive it. */
export const DB_FILE = "exa-local.db"
export const DB_SIDECARS = [`${DB_FILE}-wal`, `${DB_FILE}-shm`]
