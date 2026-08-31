import path from "path"
import { Effect } from "effect"
import { Global } from "@exa/core/global"
import { Config } from "@/config/config"
import { effectCmd, fail } from "../effect-cmd"
import { UI } from "../ui"
import { DB_SIDECARS, isBundle, pruneList, resolveBackup } from "../../backup/backup"
import { createBackup } from "../../backup/create"

/**
 * `exa backup` — create, list and restore local session backups, and hand the
 * bundle to a sync command of the user's choosing.
 *
 * Bundles are plain tar.gz, so a restore never depends on this tool: you can
 * unpack one by hand into the data directory.
 */

async function sh(cmd: string[], cwd?: string) {
  const proc = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" })
  const code = await proc.exited
  if (code !== 0) {
    const err = await new Response(proc.stderr).text()
    throw new Error(`${cmd[0]} failed (${code}): ${err.trim().slice(0, 300)}`)
  }
  return await new Response(proc.stdout).text()
}

export const BackupCommand = effectCmd({
  command: "backup [action] [target]",
  describe: "create, list or restore local backups of your sessions",
  builder: (yargs) =>
    yargs
      .positional("action", {
        describe: "create (default), list, restore, prune",
        type: "string",
        choices: ["create", "list", "restore", "prune"] as const,
      })
      .positional("target", { describe: "bundle file, for restore", type: "string" })
      .option("dir", { describe: "override the backup directory", type: "string" }),
  handler: Effect.fn("Cli.backup")(function* (args) {
    const cfg = yield* Config.use.get()
    const dataDir = Global.Path.data
    const resolved = resolveBackup((cfg as { backup?: Parameters<typeof resolveBackup>[0] }).backup, dataDir)
    const dir = args.dir?.trim() || resolved.directory
    const fs = yield* Effect.promise(() => import("node:fs/promises"))

    const action = args.action ?? "create"

    if (action === "list") {
      const names = yield* Effect.promise(() => fs.readdir(dir).catch(() => [] as string[]))
      const bundles = names.filter(isBundle).sort().reverse()
      if (bundles.length === 0) {
        UI.println(`no backups in ${dir}`)
        return
      }
      UI.println(`backups in ${dir}:`)
      for (const name of bundles) {
        const stat = yield* Effect.promise(() => fs.stat(path.join(dir, name)).catch(() => undefined))
        const size = stat ? `${(stat.size / 1024 / 1024).toFixed(1)} MB` : "?"
        UI.println(`  ${name}  ${size}`)
      }
      return
    }

    if (action === "prune") {
      const names = yield* Effect.promise(() => fs.readdir(dir).catch(() => [] as string[]))
      const stale = pruneList(names, resolved.retain)
      for (const name of stale) yield* Effect.promise(() => fs.rm(path.join(dir, name), { force: true }))
      UI.println(`pruned ${stale.length} bundle(s); keeping ${resolved.retain}`)
      return
    }

    if (action === "restore") {
      const file = args.target?.trim()
      if (!file) return yield* fail("Name the bundle to restore: exa backup restore <file>")
      const bundle = path.isAbsolute(file) ? file : path.join(dir, file)
      const exists = yield* Effect.promise(() => fs.stat(bundle).then(() => true).catch(() => false))
      if (!exists) return yield* fail(`No such bundle: ${bundle}`)
      // Restores overwrite session history in place, so say exactly what will
      // happen and where — this is not undoable.
      UI.println(`restoring ${bundle}`)
      UI.println(`into ${dataDir}`)
      // A restored database must not meet the previous database's WAL: SQLite
      // would try to replay it and refuse to open the file.
      for (const sidecar of DB_SIDECARS)
        yield* Effect.promise(() => fs.rm(path.join(dataDir, sidecar), { force: true }))
      yield* Effect.promise(() => sh(["tar", "-xzf", bundle, "-C", dataDir]))
      UI.println("restored. Restart any running exa session to pick it up.")
      return
    }

    // create
    const result = yield* Effect.promise(() => createBackup(dataDir, { ...resolved, directory: dir }))
    if (!result) return yield* fail(`Nothing to back up yet in ${dataDir}`)
    UI.println(`backup: ${result.file} (${(result.bytes / 1024 / 1024).toFixed(1)} MB)`)
    if (!resolved.includeCredentials) UI.println("credentials excluded — safe to sync off-machine")
    if (result.pruned) UI.println(`pruned ${result.pruned} older bundle(s)`)
    if (result.synced === true) UI.println("synced")
    if (result.synced === false) UI.println("sync failed — the local bundle is still in place")
  }),
})
