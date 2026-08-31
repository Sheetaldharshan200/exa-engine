import type { Plugin } from "@exa/plugin"
import { Global } from "@exa/core/global"
import { resolveBackup } from "../backup/backup"
import { createBackup } from "../backup/create"

/**
 * Autosave: write a backup bundle after the session goes quiet.
 *
 * Debounced rather than periodic — a backup lands shortly after you stop
 * working, which is when it is worth taking, and a long session does not
 * produce a bundle every few minutes. Failures are deliberately silent in the
 * session: a backup problem must never interrupt the user's work, and
 * `exa backup` reports properly when run by hand.
 */
export const BackupAutosavePlugin: Plugin = async ({ client: _client }) => {
  let timer: ReturnType<typeof setTimeout> | undefined
  let running = false

  // Read the backup section straight from the config file: this hook runs
  // outside the Effect runtime, and only needs a few plain fields.
  const readBackupConfig = async () => {
    const fs = await import("node:fs/promises")
    const path = await import("node:path")
    for (const name of ["exa.json", "exa.jsonc"]) {
      try {
        const text = await fs.readFile(path.join(Global.Path.config, name), "utf8")
        const stripped = text.replace(/^\s*\/\/.*$/gm, "")
        return (JSON.parse(stripped) as { backup?: Parameters<typeof resolveBackup>[0] }).backup
      } catch {
        /* absent or unparseable — try the next name */
      }
    }
    return undefined
  }

  const schedule = async () => {
    const resolved = resolveBackup(await readBackupConfig(), Global.Path.data)
    if (!resolved.enabled) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(async () => {
      if (running) return
      running = true
      try {
        await createBackup(Global.Path.data, resolved)
      } catch {
        /* never interrupt a session for a backup */
      } finally {
        running = false
      }
    }, resolved.debounceMs)
    // Node keeps the process alive for pending timers; a backup is not a
    // reason to hold a CLI run open.
    timer.unref?.()
  }

  return {
    event: async ({ event }) => {
      // Session content changed — messages added, session updated or removed.
      if (typeof event?.type === "string" && event.type.startsWith("session.")) await schedule()
    },
  }
}
