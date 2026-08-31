import { describe, expect, test } from "bun:test"
import { copiedMessage } from "./clipboard-message"

describe("copiedMessage", () => {
  // "Copied to clipboard" left the user guessing whether they got the line
  // they meant or the whole scrollback.
  test("states how much was copied", () => {
    expect(copiedMessage("hello")).toBe("Copied 5 characters")
  })

  test("groups large counts so they can be read at a glance", () => {
    expect(copiedMessage("x".repeat(12345))).toBe("Copied 12,345 characters")
  })

  test("says character, not characters, for one", () => {
    expect(copiedMessage("x")).toBe("Copied 1 character")
  })

  test("handles an empty copy", () => {
    expect(copiedMessage("")).toBe("Copied 0 characters")
  })

  // Counting UTF-16 units would report 2 for a single emoji, which is not
  // what anyone means by "characters".
  test("counts what a person would call a character", () => {
    expect(copiedMessage("⛁⛁")).toBe("Copied 2 characters")
    expect(copiedMessage("😀")).toBe("Copied 1 character")
  })

  test("takes a caller's wording", () => {
    expect(copiedMessage("abc", "Copied debug info —")).toBe("Copied debug info — 3 characters")
  })
})
