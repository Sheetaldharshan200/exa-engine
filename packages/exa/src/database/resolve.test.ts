import { describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import nodePath from "node:path"
import { matchConnection } from "./connection"
import type { ConnectionEntry } from "./registry"

function conn(id: string, name: string, host = "127.0.0.1", port = 8563): ConnectionEntry {
  return { id, name, host, port, user: "sys" }
}

const FIVE = [
  conn("127.0.0.1_8563_sys", "sales-prod"),
  conn("127.0.0.1_8564_sys", "sales-staging", "127.0.0.1", 8564),
  conn("db.example.com_8563_analyst", "warehouse", "db.example.com"),
  conn("10.0.0.4_8563_sys", "finance"),
  conn("10.0.0.5_8563_sys", "hr"),
]

describe("matchConnection", () => {
  test("matches the display name", () => {
    const found = matchConnection(FIVE, "finance")
    expect(found.ok && found.connection.id).toBe("10.0.0.4_8563_sys")
  })

  test("matches the registry id", () => {
    const found = matchConnection(FIVE, "db.example.com_8563_analyst")
    expect(found.ok && found.connection.name).toBe("warehouse")
  })

  test("matches host:port", () => {
    const found = matchConnection(FIVE, "127.0.0.1:8564")
    expect(found.ok && found.connection.name).toBe("sales-staging")
  })

  test("ignores case and surrounding space", () => {
    const found = matchConnection(FIVE, "  Finance ")
    expect(found.ok && found.connection.name).toBe("finance")
  })

  test("accepts an unambiguous partial name", () => {
    const found = matchConnection(FIVE, "ware")
    expect(found.ok && found.connection.name).toBe("warehouse")
  })

  // The important one. Querying the wrong database returns a plausible number
  // from the wrong place, which is worse than any error message.
  test("refuses an ambiguous partial rather than guessing", () => {
    const found = matchConnection(FIVE, "sales")
    expect(found.ok).toBe(false)
    if (!found.ok) {
      expect(found.reason).toBe("ambiguous")
      expect(found.candidates.map((c) => c.name).sort()).toEqual(["sales-prod", "sales-staging"])
    }
  })

  // An exact name must win even when it is also a prefix of another, or
  // "sales-prod" could never be selected once "sales-prod-2" exists.
  test("an exact name beats a longer name containing it", () => {
    const withSuffix = [...FIVE, conn("x", "sales-prod-2")]
    const found = matchConnection(withSuffix, "sales-prod")
    expect(found.ok && found.connection.id).toBe("127.0.0.1_8563_sys")
  })

  test("reports no match with the full list to choose from", () => {
    const found = matchConnection(FIVE, "marketing")
    expect(found.ok).toBe(false)
    if (!found.ok) {
      expect(found.reason).toBe("none")
      expect(found.candidates).toHaveLength(5)
    }
  })

  test("handles an empty registry", () => {
    const found = matchConnection([], "anything")
    expect(found.ok).toBe(false)
  })
})

describe("the default database", () => {
  const dir = mkdtempSync(nodePath.join(tmpdir(), "exa-default-"))

  function registry(body: object) {
    const file = nodePath.join(dir, `r${Math.random().toString(36).slice(2)}.json`)
    writeFileSync(file, JSON.stringify(body))
    process.env["EXASOL_CONNECTIONS_FILE"] = file
    return file
  }

  test("is remembered across reads", async () => {
    registry({ version: 1, connections: [conn("a", "alpha")], defaultId: "a" })
    const { parseRegistry } = await import("./registry")
    const text = await import("node:fs/promises").then((fs) =>
      fs.readFile(process.env["EXASOL_CONNECTIONS_FILE"]!, "utf8"),
    )
    expect(parseRegistry(text).defaultId).toBe("a")
  })

  // An older exa, or a hand-edited file, simply has no defaultId.
  test("is absent rather than invented when the file predates it", async () => {
    const { parseRegistry } = await import("./registry")
    expect(parseRegistry(JSON.stringify({ version: 1, connections: [] })).defaultId).toBeUndefined()
  })

  test("ignores a non-string value", async () => {
    const { parseRegistry } = await import("./registry")
    expect(parseRegistry(JSON.stringify({ version: 1, connections: [], defaultId: 7 })).defaultId).toBeUndefined()
  })
})
