import { describe, expect, test } from "bun:test"
import { spawnPermissions } from "./team-spawn"

/** Mirrors session/tools.ts: rules are concatenated and the last match wins. */
function effective(rules: ReturnType<typeof spawnPermissions>, tool: string): string | undefined {
  return rules.findLast((rule) => rule.permission === tool)?.action
}

describe("spawnPermissions", () => {
  // The bug this pins: a teammate spawned as a coding role (`explore`, whose
  // own permissions are a code-tool allowlist over "*": "deny") had no
  // database access, so it reported back that it could not run the query —
  // a task that looks complete with the answer missing.
  test("every teammate can reach the database, whatever role it was spawned as", () => {
    for (const readOnly of [true, false]) {
      const rules = spawnPermissions({ worktreeDir: null, isReadOnly: readOnly })
      for (const tool of ["exasol_query", "exasol_schemas", "exasol_tables", "exasol_describe"]) {
        expect(effective(rules, tool)).toBe("allow")
      }
    }
  })

  test("every teammate can talk to the team", () => {
    const rules = spawnPermissions({ worktreeDir: null, isReadOnly: true })
    expect(effective(rules, "team_message")).toBe("allow")
    expect(effective(rules, "team_claim")).toBe("allow")
  })

  // Read-only roles stay read-only: granting the data tools must not have
  // quietly handed them the filesystem or a shell.
  test("a read-only teammate still cannot edit files or run commands", () => {
    const rules = spawnPermissions({ worktreeDir: null, isReadOnly: true })
    expect(effective(rules, "edit")).toBe("deny")
    expect(effective(rules, "bash")).toBe("deny")
  })

  test("a worktree teammate may edit inside its worktree and run commands", () => {
    const rules = spawnPermissions({ worktreeDir: "/tmp/wt", isReadOnly: false })
    expect(rules.find((r) => r.permission === "edit")?.pattern).toBe("/tmp/wt/**")
    expect(effective(rules, "bash")).toBe("allow")
  })

  // A read-only teammate never gets a worktree write grant, even if one was
  // somehow passed alongside.
  test("read-only wins over a worktree write grant", () => {
    const rules = spawnPermissions({ worktreeDir: "/tmp/wt", isReadOnly: true })
    expect(effective(rules, "edit")).toBe("deny")
    expect(effective(rules, "bash")).toBe("deny")
  })
})
