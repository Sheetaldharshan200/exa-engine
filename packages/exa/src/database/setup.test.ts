import { describe, expect, test } from "bun:test"
import { choiceFromValue, setupOptions } from "./setup"
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
