import { describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createDb } from "./db"

const DB_MODULE = path.join(import.meta.dir, "db.ts")

/** Open the database in a CHILD process (the real-world shape: sidecars are
 *  left behind by a previous run, not corrupted under a live mmap — doing
 *  that in-process bus-errors bun itself, which no handler can catch). */
function openInChildProcess(file: string): { ok: boolean; output: string } {
  const result = Bun.spawnSync([
    process.execPath,
    "-e",
    `import { createDb } from ${JSON.stringify(DB_MODULE)}
     const db = createDb(${JSON.stringify(file)})
     db.exec("SELECT 1")
     console.log("usable")`,
  ])
  return {
    ok: result.exitCode === 0,
    output: result.stdout.toString() + result.stderr.toString(),
  }
}

describe("createDb", () => {
  test("opens and migrates a fresh database", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "exa-teams-"))
    const file = path.join(dir, "ensemble.db")
    const db = createDb(file)
    db.exec("SELECT 1")
    expect(existsSync(file)).toBe(true)
  })

  // Regression: a `-wal`/`-shm` sidecar that outlives its database makes every
  // open fail with "disk I/O error". The plugin load failure is only logged at
  // debug level, so this silently removed EVERY team tool — the whole
  // orchestration layer vanished with no user-visible reason (observed
  // 2026-08-14, after a manual wipe deleted the db but left the sidecars).
  test("recovers when WAL sidecars outlive the database", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "exa-teams-"))
    const file = path.join(dir, "ensemble.db")
    expect(openInChildProcess(file).ok).toBe(true)
    writeFileSync(file + "-shm", "stale shm from a previous run")
    writeFileSync(file + "-wal", "stale wal from a previous run")
    const retried = openInChildProcess(file)
    expect(retried.ok).toBe(true)
    expect(retried.output).toContain("usable")
  })

  // The nastier case: bun's SQLite ACCEPTS a non-SQLite file, serves queries
  // from memory for the life of the process and persists nothing — so without
  // the header guard the state silently resets every run and nothing throws.
  test("quarantines a non-SQLite file and persists a fresh database", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "exa-teams-"))
    const file = path.join(dir, "ensemble.db")
    writeFileSync(file, "this is not a sqlite database at all, just text")

    expect(openInChildProcess(file).ok).toBe(true)
    expect(existsSync(file + ".corrupt")).toBe(true)
    expect(readFileSync(file).subarray(0, 15).toString()).toBe("SQLite format 3")

    // The schema must survive into a SECOND process — the whole point.
    const second = openInChildProcess(file)
    expect(second.ok).toBe(true)
    expect(second.output).toContain("usable")
  })
})
