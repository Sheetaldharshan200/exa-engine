import { createRequire } from "node:module"
import { closeSync, openSync, readSync, renameSync, rmSync } from "node:fs"
import path from "node:path"
import { applyMigrations } from "./schema"

interface SqliteStatement {
  get(...params: unknown[]): unknown
  all(...params: unknown[]): unknown[]
  run(...params: unknown[]): unknown
}

interface SqliteRunResult {
  changes: number
}

/** Minimal synchronous SQLite database interface used by Ensemble. */
export interface Database {
  exec(sql: string): void
  query(sql: string): SqliteStatement
  run(sql: string, ...params: unknown[]): SqliteRunResult
  transaction<TArgs extends unknown[], TResult>(fn: (...args: TArgs) => TResult): (...args: TArgs) => TResult
  close(): void
}

interface BunSqliteModule {
  Database: new (filename: string) => Database
}

interface NodeSqliteDatabase {
  exec(sql: string): void
  prepare(sql: string): SqliteStatement
  close(): void
}

interface NodeSqliteModule {
  DatabaseSync: new (filename: string) => NodeSqliteDatabase
}

const requireRuntimeModule = createRequire(import.meta.url)

let instance: Database | undefined

class NodeSqliteAdapter implements Database {
  private readonly db: NodeSqliteDatabase

  constructor(filename: string) {
    const sqlite = requireRuntimeModule(["node", "sqlite"].join(":")) as NodeSqliteModule
    this.db = new sqlite.DatabaseSync(filename)
  }

  exec(sql: string): void {
    this.db.exec(sql)
  }

  query(sql: string): SqliteStatement {
    return this.db.prepare(sql)
  }

  run(sql: string, ...params: unknown[]): SqliteRunResult {
    const bindings = params.length === 1 && Array.isArray(params[0]) ? params[0] : params
    return this.db.prepare(sql).run(...bindings) as SqliteRunResult
  }

  transaction<TArgs extends unknown[], TResult>(fn: (...args: TArgs) => TResult): (...args: TArgs) => TResult {
    return (...args: TArgs): TResult => {
      this.exec("BEGIN")
      try {
        const result = fn(...args)
        this.exec("COMMIT")
        return result
      } catch (err) {
        this.exec("ROLLBACK")
        throw err
      }
    }
  }

  close(): void {
    this.db.close()
  }
}

function openDatabase(filename: string): Database {
  if (typeof process.versions.bun === "string") {
    const sqlite = requireRuntimeModule(["bun", "sqlite"].join(":")) as BunSqliteModule
    return new sqlite.Database(filename)
  }

  return new NodeSqliteAdapter(filename)
}

/**
 * Resolve the path for the global ensemble SQLite database.
 * Project data is logically isolated by project_id inside this DB.
 */
export function getDbPath(env: Record<string, string | undefined> = process.env): string {
  const home = env.HOME ?? env.USERPROFILE ?? "~"
  return path.join(home, ".config", "exa", "ensemble.db")
}

/** Open + migrate the database at `path` (WAL, foreign keys on). */
function open(path: string): Database {
  const db = openDatabase(path)
  db.exec("PRAGMA journal_mode=WAL")
  db.exec("PRAGMA foreign_keys=ON")
  applyMigrations(db)
  return db
}

/** SQLite's file magic: every real database starts with these 16 bytes. */
const SQLITE_MAGIC = "SQLite format 3\0"

/**
 * Quarantine a database file that is present but is NOT SQLite. Relying on the
 * open call to fail is not enough: bun's SQLite accepts such a file, serves
 * queries from memory for the life of the process, and never persists them —
 * so state silently disappears between runs and nothing ever throws (verified
 * 2026-08-14: a 47-byte text file stayed 47 bytes while queries "succeeded").
 * Checking the magic first makes the outcome deterministic across runtimes.
 */
function quarantineIfNotSqlite(file: string): void {
  let header: Buffer
  try {
    const handle = openSync(file, "r")
    try {
      header = Buffer.alloc(SQLITE_MAGIC.length)
      const read = readSync(handle, header, 0, header.length, 0)
      if (read === 0) return // empty file — SQLite initializes it normally
      if (read < header.length) header = header.subarray(0, read)
    } finally {
      closeSync(handle)
    }
  } catch {
    return // missing or unreadable — let the open path handle it
  }
  if (header.toString("binary") === SQLITE_MAGIC.slice(0, header.length)) return
  // Keep the evidence next to it; the orchestration state itself is disposable.
  try {
    renameSync(file, `${file}.corrupt`)
  } catch {
    try {
      rmSync(file, { force: true })
    } catch {
      /* best effort */
    }
  }
  for (const suffix of ["-wal", "-shm"]) {
    try {
      rmSync(file + suffix, { force: true })
    } catch {
      /* best effort */
    }
  }
}

/**
 * Create and initialize the orchestration state database.
 *
 * Two independent failure modes are handled, because a failing plugin load is
 * only logged at debug level — a broken state file silently removes the ENTIRE
 * orchestration layer, every team tool vanishing with no user-visible reason:
 *
 *  1. A file that is present but NOT SQLite is quarantined up front (see
 *     quarantineIfNotSqlite) — bun's SQLite would otherwise accept it and
 *     lose every write on exit.
 *  2. WAL `-wal`/`-shm` sidecars that outlive their database (a hand-deleted
 *     file, a wiped data dir, an interrupted write) make every open fail with
 *     "disk I/O error" — observed for real on 2026-08-14. A failed open
 *     retries after clearing the sidecars, then once more with the database
 *     removed: team/task history is disposable, an unusable orchestration
 *     layer is not.
 */
export function createDb(path: string): Database {
  quarantineIfNotSqlite(path)
  try {
    instance = open(path)
    return instance
  } catch (first) {
    for (const suffix of ["-wal", "-shm"]) {
      try {
        rmSync(path + suffix, { force: true })
      } catch {
        /* best effort */
      }
    }
    try {
      instance = open(path)
      return instance
    } catch {
      try {
        rmSync(path, { force: true })
      } catch {
        /* best effort */
      }
      try {
        instance = open(path)
        return instance
      } catch {
        throw first
      }
    }
  }
}

/** Get the singleton database instance. Must call createDb first. */
export function getDb(): Database {
  if (!instance) throw new Error("Database not initialized. Call createDb() first.")
  return instance
}
