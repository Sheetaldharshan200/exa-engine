import { describe, expect, test } from "bun:test"
import { extensionId } from "./index"

describe("extensionId", () => {
  // The bug this fixes: running exa in an editor terminal ran
  // `--install-extension sst-dev.exa`, installing the upstream project's
  // extension — a different product, from a different publisher, with no
  // indication that was happening.
  test("installs this project's extension, not the upstream one", () => {
    expect(extensionId({})).toBe("sheetaldharshan200.exa")
    expect(extensionId({})).not.toContain("sst-dev")
  })

  // A fork publishing under its own publisher id needs this to follow.
  test("an override wins", () => {
    expect(extensionId({ EXA_VSCODE_EXTENSION_ID: "acme.exa" })).toBe("acme.exa")
  })

  test("ignores an empty or blank override", () => {
    expect(extensionId({ EXA_VSCODE_EXTENSION_ID: "" })).toBe("sheetaldharshan200.exa")
    expect(extensionId({ EXA_VSCODE_EXTENSION_ID: "   " })).toBe("sheetaldharshan200.exa")
  })

  // It is publisher.name on the marketplace; anything else fails to install.
  test("is a marketplace id, not a bare name", () => {
    expect(extensionId({}).split(".").length).toBe(2)
  })
})
