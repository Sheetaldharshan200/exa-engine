import { describe, expect, test } from "bun:test"
import { oneEntryPerName } from "./models"

/** The ids and names GitHub actually returned for a real Copilot account. */
const REAL = new Map([
  ["gpt-4o-mini-2024-07-18", { name: "GPT-4o mini" }],
  ["gpt-4o-2024-11-20", { name: "GPT-4o" }],
  ["gpt-4o-2024-08-06", { name: "GPT-4o" }],
  ["gpt-3.5-turbo-0613", { name: "GPT 3.5 Turbo" }],
  ["gpt-3.5-turbo", { name: "GPT 3.5 Turbo" }],
  ["gpt-4o-mini", { name: "GPT-4o mini" }],
  ["gpt-4o", { name: "GPT-4o" }],
])

describe("oneEntryPerName", () => {
  // Seven ids, three names: the picker listed "GPT-4o" three times with
  // nothing to distinguish the rows.
  test("collapses ids that share a display name", () => {
    const kept = oneEntryPerName(REAL.keys(), REAL)
    expect([...kept].sort()).toEqual(["gpt-3.5-turbo", "gpt-4o", "gpt-4o-mini"])
  })

  // The alias is the one GitHub moves forward as models are updated; a dated
  // snapshot eventually stops being served.
  test("keeps the stable alias over its dated snapshots", () => {
    const kept = oneEntryPerName(["gpt-4o-2024-11-20", "gpt-4o", "gpt-4o-2024-08-06"], REAL)
    expect([...kept]).toEqual(["gpt-4o"])
  })

  test("keeps the newest when every id for a name is dated", () => {
    const items = new Map([
      ["gpt-4o-2024-08-06", { name: "GPT-4o" }],
      ["gpt-4o-2024-11-20", { name: "GPT-4o" }],
    ])
    expect([...oneEntryPerName(items.keys(), items)]).toEqual(["gpt-4o-2024-11-20"])
  })

  test("recognises the short date suffix GitHub uses for older models", () => {
    const items = new Map([
      ["gpt-3.5-turbo-0613", { name: "GPT 3.5 Turbo" }],
      ["gpt-3.5-turbo", { name: "GPT 3.5 Turbo" }],
    ])
    expect([...oneEntryPerName(items.keys(), items)]).toEqual(["gpt-3.5-turbo"])
  })

  test("leaves distinct models alone", () => {
    const items = new Map([
      ["gpt-4o", { name: "GPT-4o" }],
      ["gpt-41-copilot", { name: "GPT-4.1 Copilot" }],
    ])
    expect([...oneEntryPerName(items.keys(), items)].sort()).toEqual(["gpt-41-copilot", "gpt-4o"])
  })

  test("handles an empty list", () => {
    expect([...oneEntryPerName([], REAL)]).toEqual([])
  })
})
