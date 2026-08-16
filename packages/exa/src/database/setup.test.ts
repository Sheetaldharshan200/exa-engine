import { describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import nodePath from "node:path"
import { choiceFromValue, setupOptions, shouldOfferSetup, unregistered } from "./setup"
import type { Candidate } from "./discover"

const running: Candidate = { host: "127.0.0.1", port: 8563, origin: 'Exasol Personal deployment "default"' }
const studio: Candidate = { host: "127.0.0.1", port: 8565, origin: "Exasol Studio's managed database (port 8565)" }

describe("setupOptions", () => {
  test("offers what is already running before offering to install", () => {
    const options = setupOptions([running, studio])
    expect(options[0].value).toBe("use:8563")
    expect(options[1].value).toBe("use:8565")
    expect(options[2].value).toBe("install")
  })

  test("states the download size before the user commits to it", () => {
    const install = setupOptions([]).find((o) => o.value === "install")!
    expect(install.hint).toContain("170 MB")
  })

  test("always leaves a way out", () => {
    expect(setupOptions([]).map((o) => o.value)).toContain("skip")
  })

  // exa is the Exasol agent: the first-run flow does not advertise other
  // database products.
  test("never offers other database types", () => {
    const text = JSON.stringify(setupOptions([running])).toLowerCase()
    for (const other of ["postgres", "snowflake", "sap", "mysql", "mcp"]) {
      expect(text).not.toContain(other)
    }
  })
})

describe("choiceFromValue", () => {
  test("maps a reuse choice back to the database it refers to", () => {
    const choice = choiceFromValue("use:8565", [running, studio])
    expect(choice).toEqual({ kind: "use", candidate: studio })
  })

  test("falls back to skip when the referenced database is gone", () => {
    // It could have been stopped between listing and choosing.
    expect(choiceFromValue("use:9999", [running]).kind).toBe("skip")
  })

  test("maps the remaining choices", () => {
    expect(choiceFromValue("install", []).kind).toBe("install")
    expect(choiceFromValue("manual", []).kind).toBe("manual")
    expect(choiceFromValue("skip", []).kind).toBe("skip")
    expect(choiceFromValue("nonsense", []).kind).toBe("skip")
  })
})

describe("unregistered", () => {
  // The complaint this fixes: Exasol Studio installed and registered the
  // database, so the CLI must not offer it as a fresh choice.
  test("hides a database that is already registered", () => {
    expect(unregistered([running], ["127.0.0.1_8563_sys"])).toEqual([])
  })

  test("matches on the database, not the user that registered it", () => {
    // Studio may have registered it as a different user; it is still the same
    // database, so it must not be offered again.
    expect(unregistered([running], ["127.0.0.1_8563_analyst"])).toEqual([])
  })

  test("still offers a running database nobody has registered", () => {
    expect(unregistered([running, studio], ["127.0.0.1_8563_sys"])).toEqual([studio])
  })

  test("offers everything when nothing is registered", () => {
    expect(unregistered([running, studio], [])).toEqual([running, studio])
  })
})

describe("shouldOfferSetup", () => {
  function withConnections(count: number) {
    const dir = mkdtempSync(nodePath.join(tmpdir(), "exa-setup-"))
    const file = nodePath.join(dir, "connections.json")
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        connections: Array.from({ length: count }, (_, i) => ({
          id: `c${i}`,
          name: `c${i}`,
          host: "127.0.0.1",
          port: 8563,
          user: "sys",
        })),
      }),
    )
    process.env.EXASOL_CONNECTIONS_FILE = file
  }

  test("asks on a fresh interactive run with no database", async () => {
    withConnections(0)
    expect(await shouldOfferSetup({ interactive: true, declined: false })).toBe(true)
  })

  // A prompt in a pipe or CI job hangs the run forever, which is worse than
  // never asking at all.
  test("never asks when there is no terminal", async () => {
    withConnections(0)
    expect(await shouldOfferSetup({ interactive: false, declined: false })).toBe(false)
  })

  test("never asks twice after the user declined", async () => {
    withConnections(0)
    expect(await shouldOfferSetup({ interactive: true, declined: true })).toBe(false)
  })

  test("never asks when a database is already connected", async () => {
    withConnections(1)
    expect(await shouldOfferSetup({ interactive: true, declined: false })).toBe(false)
  })
})
