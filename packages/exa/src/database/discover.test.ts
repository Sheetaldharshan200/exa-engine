import { describe, expect, test } from "bun:test"
import { parseDeployments } from "./discover"

describe("parseDeployments", () => {
  // Captured from a real `exasol deployments list` run.
  const real = "default status=running preset=local/local path=/Users/u/.exasol/personal/deployments/default"

  test("reads a real launcher line", () => {
    const [c] = parseDeployments(real)
    expect(c.deployment).toBe("default")
    expect(c.status).toBe("running")
    expect(c.host).toBe("127.0.0.1")
    expect(c.port).toBe(8563)
    expect(c.origin).toContain("default")
  })

  test("uses an explicit port when the launcher reports one", () => {
    expect(parseDeployments("studio status=running preset=local/local port=8565")[0].port).toBe(8565)
  })

  test("skips cloud deployments, which are not reachable as a local database", () => {
    const lines = [real, "aws-prod status=running preset=aws/eu-central-1"].join("\n")
    expect(parseDeployments(lines).map((c) => c.deployment)).toEqual(["default"])
  })

  test("keeps stopped deployments so callers can decide (discover filters them)", () => {
    const [c] = parseDeployments("default status=stopped preset=local/local")
    expect(c.status).toBe("stopped")
  })

  test("tolerates blank lines, headers and junk instead of throwing", () => {
    expect(parseDeployments("")).toEqual([])
    expect(parseDeployments("\n\n  \n")).toEqual([])
    expect(parseDeployments("NAME STATUS PRESET")).toEqual([])
    const [c] = parseDeployments("weird-line-with-no-fields")
    expect(c.port).toBe(8563) // falls back to the default port rather than NaN
  })
})
