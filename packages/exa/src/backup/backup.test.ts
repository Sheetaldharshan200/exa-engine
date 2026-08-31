import { describe, expect, test } from "bun:test"
import path from "path"
import { bundleName, bundlePaths, isBundle, pruneList, resolveBackup } from "./backup"

describe("resolveBackup", () => {
  test("defaults are safe: enabled, no credentials, sane retention", () => {
    const r = resolveBackup(undefined, "/data")
    expect(r.enabled).toBe(true)
    expect(r.includeCredentials).toBe(false)
    expect(r.directory).toBe(path.join("/data", "backup"))
    expect(r.retain).toBe(10)
    expect(r.debounceMs).toBe(60_000)
    expect(r.syncCommand).toBeUndefined()
  })

  test("honors overrides and trims an empty directory back to the default", () => {
    const r = resolveBackup(
      { enabled: false, directory: "  ", retain: 3, debounceSeconds: 5, includeCredentials: true },
      "/data",
    )
    expect(r.enabled).toBe(false)
    expect(r.directory).toBe(path.join("/data", "backup"))
    expect(r.retain).toBe(3)
    expect(r.debounceMs).toBe(5_000)
    expect(r.includeCredentials).toBe(true)
  })

  test("clamps nonsense values instead of producing a broken schedule", () => {
    const r = resolveBackup({ retain: 0, debounceSeconds: -10 }, "/data")
    expect(r.retain).toBe(1)
    expect(r.debounceMs).toBe(1_000)
  })

  test("an all-empty sync command is treated as no sync", () => {
    expect(resolveBackup({ sync: { command: ["", "  "] } }, "/d").syncCommand).toBeUndefined()
    expect(resolveBackup({ sync: { command: ["aws", "s3", "cp"] } }, "/d").syncCommand).toEqual(["aws", "s3", "cp"])
  })
})

describe("bundle naming", () => {
  test("names are filesystem-safe and sort chronologically", () => {
    const a = bundleName(new Date("2026-01-02T03:04:05.678Z"))
    const b = bundleName(new Date("2026-01-02T03:04:06.000Z"))
    expect(a).not.toContain(":")
    expect(a.endsWith(".tar.gz")).toBe(true)
    expect([b, a].sort()).toEqual([a, b])
  })

  test("only our own bundles are recognized", () => {
    expect(isBundle(bundleName(new Date()))).toBe(true)
    expect(isBundle("notes.tar.gz")).toBe(false)
    expect(isBundle("exa-backup-2026.zip")).toBe(false)
  })
})

describe("pruneList", () => {
  const names = [
    bundleName(new Date("2026-01-01T00:00:00Z")),
    bundleName(new Date("2026-01-02T00:00:00Z")),
    bundleName(new Date("2026-01-03T00:00:00Z")),
  ]

  test("keeps the newest and returns the rest oldest-first", () => {
    expect(pruneList(names, 1)).toEqual([names[0], names[1]])
    expect(pruneList(names, 2)).toEqual([names[0]])
    expect(pruneList(names, 3)).toEqual([])
    expect(pruneList(names, 99)).toEqual([])
  })

  test("never deletes files it did not create", () => {
    expect(pruneList([...names, "important.tar.gz", "auth.json"], 1)).toEqual([names[0], names[1]])
  })

  test("retain below 1 still keeps one bundle", () => {
    expect(pruneList(names, 0)).toEqual([names[0], names[1]])
  })
})

describe("bundlePaths", () => {
  test("credentials are excluded unless explicitly requested", () => {
    expect(bundlePaths(false)).not.toContain("auth.json")
    expect(bundlePaths(true)).toContain("auth.json")
  })

  test("always carries the session store", () => {
    expect(bundlePaths(false)).toContain("storage")
  })
})
