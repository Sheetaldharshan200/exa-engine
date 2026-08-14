/**
 * Creating a backup bundle. Shared by `exa backup` and the autosave hook so
 * both take exactly the same path — one implementation to get right.
 */
import path from "path"
import { DB_FILE, bundleName, bundlePaths, pruneList, type ResolvedBackup } from "./backup"

async function run(cmd: string[]) {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" })
  const code = await proc.exited
  if (code !== 0) {
    const err = await new Response(proc.stderr).text()
    throw new Error(`${cmd[0]} failed (${code}): ${err.trim().slice(0, 300)}`)
  }
}

export type BackupResult = { file: string; bytes: number; pruned: number; synced: boolean | undefined }

/**
 * Write one bundle, prune older ones, and hand it to the sync command when
 * configured. Returns undefined when there is nothing worth backing up.
 *
 * The SQLite database is captured with VACUUM INTO rather than copied: a live
 * database's WAL lives beside it, so a plain copy can produce a file SQLite
 * later refuses to open.
 */
export async function createBackup(dataDir: string, resolved: ResolvedBackup): Promise<BackupResult | undefined> {
  const fs = await import("node:fs/promises")
  const nodeFs = await import("node:fs")

  const paths = bundlePaths(resolved.includeCredentials).filter((p) => nodeFs.existsSync(path.join(dataDir, p)))
  const dbPath = path.join(dataDir, DB_FILE)
  const hasDb = nodeFs.existsSync(dbPath)
  if (paths.length === 0 && !hasDb) return undefined

  await fs.mkdir(resolved.directory, { recursive: true })
  const out = path.join(resolved.directory, bundleName(new Date()))

  // Staged in its own directory so the archive entry keeps the database's
  // real name — a restore has to land on exa-local.db, not a variant.
  const stageDir = path.join(dataDir, ".backup-staging")
  if (hasDb) {
    await fs.rm(stageDir, { recursive: true, force: true })
    await fs.mkdir(stageDir, { recursive: true })
    const { Database } = await import("bun:sqlite")
    const db = new Database(dbPath, { readonly: true })
    try {
      db.run(`VACUUM INTO '${path.join(stageDir, DB_FILE).replaceAll("'", "''")}'`)
    } finally {
      db.close()
    }
  }

  try {
    await run(["tar", "-czf", out, "-C", dataDir, ...paths, ...(hasDb ? ["-C", stageDir, DB_FILE] : [])])
  } finally {
    await fs.rm(stageDir, { recursive: true, force: true })
  }

  const stat = await fs.stat(out)
  const names = await fs.readdir(resolved.directory).catch(() => [] as string[])
  const stale = pruneList(names, resolved.retain)
  for (const old of stale) await fs.rm(path.join(resolved.directory, old), { force: true })

  let synced: boolean | undefined
  if (resolved.syncCommand) {
    // A failed sync must not lose the local bundle — it is already on disk.
    synced = await run([...resolved.syncCommand, out]).then(
      () => true,
      () => false,
    )
  }

  return { file: out, bytes: stat.size, pruned: stale.length, synced }
}
