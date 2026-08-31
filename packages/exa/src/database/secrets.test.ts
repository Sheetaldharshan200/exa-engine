import { describe, expect, test } from "bun:test"
import { SERVICE, deleteCommand, preferredBackend, readCommand, writeCommand } from "./secrets"

describe("preferredBackend", () => {
  test("uses each platform's own credential store", () => {
    expect(preferredBackend("darwin")).toBe("keychain")
    expect(preferredBackend("linux")).toBe("secret-service")
    expect(preferredBackend("win32")).toBe("wincred")
  })

  test("falls back to a file on platforms without one", () => {
    expect(preferredBackend("freebsd")).toBe("file")
  })
})

describe("commands", () => {
  // Both programs must address the same item, or a secret saved in Exasol
  // Studio is invisible to the CLI and the other way round.
  test("every backend addresses the item by the shared service name and id", () => {
    for (const backend of ["keychain", "secret-service", "wincred"] as const) {
      for (const cmd of [
        readCommand(backend, "my-db"),
        writeCommand(backend, "my-db", "pw"),
        deleteCommand(backend, "my-db"),
      ]) {
        const text = cmd!.join(" ")
        expect(text).toContain(SERVICE)
        expect(text).toContain("my-db")
      }
    }
  })

  test("the keychain write updates in place instead of failing on a repeat", () => {
    // Without -U, `security add-generic-password` errors when the item exists,
    // so re-saving a connection would appear to work and silently keep the old
    // password.
    expect(writeCommand("keychain", "id", "pw")).toContain("-U")
  })

  test("the file backend has no command — it is handled by the caller", () => {
    expect(readCommand("file", "id")).toBeUndefined()
    expect(writeCommand("file", "id", "pw")).toBeUndefined()
    expect(deleteCommand("file", "id")).toBeUndefined()
  })

  // The secret must never be visible in a process listing on Linux, which is
  // why secret-tool takes it on stdin rather than as an argument.
  test("secret-service does not put the password on the command line", () => {
    expect(writeCommand("secret-service", "id", "hunter2")!.join(" ")).not.toContain("hunter2")
  })
})
