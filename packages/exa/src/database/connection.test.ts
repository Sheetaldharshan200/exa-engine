import { describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

/** Build a temp shared registry and point the module at it. */
function withRegistry(entries: { id: string; createdAt: string; password?: string }[]) {
  const dir = mkdtempSync(path.join(tmpdir(), "exa-registry-"))
  const file = path.join(dir, "connections.json")
  writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      connections: entries.map((e) => ({
        id: e.id,
        name: e.id,
        host: "127.0.0.1",
        port: 8563,
        user: "sys",
        createdAt: e.createdAt,
      })),
    }),
  )
  mkdirSync(path.join(dir, "credentials"), { recursive: true })
  for (const e of entries) {
    if (e.password !== undefined) writeFileSync(path.join(dir, "credentials", e.id), e.password)
  }
  process.env.EXASOL_CONNECTIONS_FILE = file
  return file
}

describe("activeConnection", () => {
  test("uses the newest connection that has a credential", async () => {
    withRegistry([
      { id: "old", createdAt: "2026-01-01T00:00:00.000Z", password: "a" },
      { id: "new", createdAt: "2026-06-01T00:00:00.000Z", password: "b" },
    ])
    const { activeConnection } = await import("./connection")
    expect((await activeConnection())?.id).toBe("new")
  })

  // Exasol Studio publishes remote databases as metadata only, keeping their
  // secrets in its vault. Such an entry must never shadow a usable database.
  test("skips an entry whose credential is not on this machine", async () => {
    withRegistry([
      { id: "usable", createdAt: "2026-01-01T00:00:00.000Z", password: "a" },
      { id: "no-secret", createdAt: "2099-01-01T00:00:00.000Z" },
    ])
    const { activeConnection } = await import("./connection")
    expect((await activeConnection())?.id).toBe("usable")
  })

  test("treats an empty credential file as unusable", async () => {
    withRegistry([
      { id: "usable", createdAt: "2026-01-01T00:00:00.000Z", password: "a" },
      { id: "blank", createdAt: "2099-01-01T00:00:00.000Z", password: "" },
    ])
    const { activeConnection } = await import("./connection")
    expect((await activeConnection())?.id).toBe("usable")
  })

  test("reports nothing when no entry is usable", async () => {
    withRegistry([{ id: "no-secret", createdAt: "2026-01-01T00:00:00.000Z" }])
    const { activeConnection, connectionsMissingCredentials } = await import("./connection")
    expect(await activeConnection()).toBeUndefined()
    expect((await connectionsMissingCredentials()).map((c) => c.id)).toEqual(["no-secret"])
  })
})
