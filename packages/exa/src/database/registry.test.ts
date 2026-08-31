import { describe, expect, test } from "bun:test"
import path from "path"
import { connectionId, credentialFile, parseDsn, parseRegistry, registryFile, remove, upsert } from "./registry"

const entry = (id: string, host = "localhost") => ({ id, name: id, host, port: 8563, user: "sys" })

describe("registryFile", () => {
  test("is shared state outside either program's private directory", () => {
    const file = registryFile({ HOME: "/home/u" })
    expect(file).toBe(path.join("/home/u", ".exasol", "connections.json"))
  })

  test("honors an explicit override", () => {
    expect(registryFile({ HOME: "/home/u", EXASOL_CONNECTIONS_FILE: "/tmp/x.json" })).toBe("/tmp/x.json")
  })

  test("credentials sit beside the registry, one file per connection", () => {
    expect(credentialFile("a_b", { HOME: "/home/u" })).toBe(
      path.join("/home/u", ".exasol", "credentials", "a_b"),
    )
  })
})

describe("parseRegistry", () => {
  test("reads a well-formed file", () => {
    const r = parseRegistry(JSON.stringify({ version: 1, connections: [entry("x")] }))
    expect(r.connections).toHaveLength(1)
  })

  // A shared file that another program is mid-write on, or that a user edited
  // badly, must never stop the CLI from starting.
  test("never throws on garbage, missing or partial content", () => {
    expect(parseRegistry(undefined).connections).toEqual([])
    expect(parseRegistry("").connections).toEqual([])
    expect(parseRegistry("not json at all").connections).toEqual([])
    expect(parseRegistry("{}").connections).toEqual([])
    expect(parseRegistry('{"connections":"nope"}').connections).toEqual([])
  })

  test("drops entries missing the fields needed to connect", () => {
    const r = parseRegistry(
      JSON.stringify({ version: 1, connections: [entry("good"), { id: "bad" }, { host: "h", port: 1 }] }),
    )
    expect(r.connections.map((c) => c.id)).toEqual(["good"])
  })
})

describe("upsert / remove", () => {
  test("replaces by id rather than duplicating", () => {
    const first = upsert({ version: 1, connections: [] }, entry("a"))
    const second = upsert(first, { ...entry("a", "other-host"), name: "renamed" })
    expect(second.connections).toHaveLength(1)
    expect(second.connections[0].host).toBe("other-host")
  })

  // The point of the shared file: two programs writing must not clobber
  // each other's entries.
  test("keeps entries written by the other program", () => {
    const studio = upsert({ version: 1, connections: [] }, { ...entry("studio-one"), source: "studio" })
    const both = upsert(studio, { ...entry("cli-one"), source: "cli" })
    expect(both.connections.map((c) => c.id).sort()).toEqual(["cli-one", "studio-one"])
    expect(remove(both, "cli-one").connections.map((c) => c.id)).toEqual(["studio-one"])
  })
})

describe("connectionId", () => {
  test("both programs derive the same id for the same target", () => {
    expect(connectionId("Localhost", 8563, "SYS")).toBe(connectionId("localhost", 8563, "sys"))
  })

  test("is filesystem-safe, since it names the credential file", () => {
    expect(connectionId("db.internal:x/y", 8563, "a b")).toMatch(/^[a-z0-9_.-]+$/)
  })
})

describe("parseDsn", () => {
  test("reads host, port, user and schema", () => {
    expect(parseDsn("exasol://analyst@db.internal:9000/SALES")).toEqual({
      host: "db.internal",
      port: 9000,
      user: "analyst",
      schema: "SALES",
    })
  })

  test("defaults the port and user", () => {
    expect(parseDsn("exasol://localhost")).toEqual({ host: "localhost", port: 8563, user: "sys", schema: undefined })
  })

  test("rejects anything that is not an exasol DSN", () => {
    expect(parseDsn("postgres://localhost")).toBeUndefined()
    expect(parseDsn("not a url")).toBeUndefined()
    expect(parseDsn("exasol://")).toBeUndefined()
  })
})
