import { describe, expect, test } from "bun:test"
import { unsecuredServerWarning } from "./server-warning"

describe("unsecuredServerWarning", () => {
  // "EXA_SERVER_PASSWORD is not set; server is unsecured" named a variable
  // and stopped. The warning must carry its own fix.
  test("says how to fix it, runnable as one line", () => {
    const lines = unsecuredServerWarning("127.0.0.1", "web")
    expect(lines.join("\n")).toContain("EXA_SERVER_PASSWORD=")
    expect(lines.join("\n")).toContain("exa web")
  })

  test("the fix names the command that was actually run", () => {
    expect(unsecuredServerWarning("127.0.0.1", "serve").join("\n")).toContain("exa serve")
  })

  // Loopback is reachable only from this machine; 0.0.0.0 is the whole
  // network. Saying "unsecured" identically for both overstates one and
  // understates the other.
  test("sizes the exposure to the binding", () => {
    expect(unsecuredServerWarning("127.0.0.1", "web")[0]).toContain("this machine")
    expect(unsecuredServerWarning("0.0.0.0", "web")[0]).toContain("network")
    expect(unsecuredServerWarning("::1", "web")[0]).toContain("this machine")
  })
})
