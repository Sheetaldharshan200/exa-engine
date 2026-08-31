import { describe, expect, test } from "bun:test"
import { toolIcon, toolLabel } from "./index"

describe("database tools in the transcript", () => {
  // A session reading the catalogue showed three identical "⚙ exasol_schemas"
  // rows — the same gear every other tool gets, and a prefix repeated on all
  // of them.
  test("carries the database mark, not the generic gear", () => {
    for (const tool of ["exasol_query", "exasol_schemas", "exasol_tables", "exasol_describe", "exasol_databases"]) {
      expect(toolIcon(tool)).toBe("⛁")
    }
  })

  test("leaves other tools alone", () => {
    expect(toolIcon("todowrite")).toBe("⚙")
    expect(toolIcon("team_spawn")).toBe("⚙")
  })

  // The prefix is on every one of them; the verb is what differs.
  test("drops the prefix that every database tool shares", () => {
    expect(toolLabel("exasol_query")).toBe("query")
    expect(toolLabel("exasol_schemas")).toBe("schemas")
    expect(toolLabel("exasol_databases")).toBe("databases")
  })

  test("leaves other tool names intact", () => {
    expect(toolLabel("todowrite")).toBe("todowrite")
    expect(toolLabel("team_spawn")).toBe("team_spawn")
  })
})
