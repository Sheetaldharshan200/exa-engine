import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import nodePath from "node:path"
import { credentialsFor, listDeployments, parseDeployment, readDeployment, studioDeploymentDir } from "./launcher"

// A real deployment.json from `exasol install local`, trimmed to the keys read.
const DEPLOYMENT = {
  backend: "local",
  deploymentId: "accd2ad0",
  deploymentState: "running",
  connection: {
    host: "127.0.0.1",
    dbPort: 8563,
    username: "sys",
    insecureSkipCertValidation: true,
  },
}

describe("parseDeployment", () => {
  test("reads the connection the launcher generated", () => {
    expect(parseDeployment(DEPLOYMENT, { dbPassword: "generated" })).toEqual({
      host: "127.0.0.1",
      port: 8563,
      user: "sys",
      password: "generated",
      state: "running",
    })
  })

  // Exasol Studio applies these same defaults in read_personal_connection; if
  // the two drift, a database one program installs is unusable in the other.
  test("falls back to the same defaults Studio uses", () => {
    expect(parseDeployment({ connection: {} }, { dbPassword: "pw" })).toMatchObject({
      host: "127.0.0.1",
      port: 8563,
      user: "sys",
    })
  })

  test("honours a deployment on a non-default port", () => {
    const moved = { ...DEPLOYMENT, connection: { ...DEPLOYMENT.connection, dbPort: 8565 } }
    expect(parseDeployment(moved, { dbPassword: "pw" })!.port).toBe(8565)
  })

  // Without a password there is nothing to connect with, and guessing one
  // turns "not installed yet" into an authentication failure the user cannot
  // explain.
  test("reports nothing rather than a connection with no password", () => {
    expect(parseDeployment(DEPLOYMENT, { dbPassword: "" })).toBeUndefined()
    expect(parseDeployment(DEPLOYMENT, {})).toBeUndefined()
    expect(parseDeployment(DEPLOYMENT, undefined)).toBeUndefined()
  })
})

describe("readDeployment", () => {
  const dirs: string[] = []
  function deployment(files: Record<string, string>): string {
    const dir = mkdtempSync(nodePath.join(tmpdir(), "exa-launcher-"))
    dirs.push(dir)
    for (const [name, body] of Object.entries(files)) writeFileSync(nodePath.join(dir, name), body)
    return dir
  }

  test("reads a deployment off disk", async () => {
    const dir = deployment({
      "deployment.json": JSON.stringify(DEPLOYMENT),
      "secrets.json": JSON.stringify({ dbPassword: "s3cret" }),
    })
    expect(await readDeployment(dir)).toMatchObject({ port: 8563, user: "sys", password: "s3cret" })
  })

  test("reports nothing when no deployment is there", async () => {
    expect(await readDeployment(nodePath.join(tmpdir(), "exa-launcher-missing"))).toBeUndefined()
  })

  // A deploy in progress leaves these files partially written; a parse error
  // must degrade to "ask the user", never crash the install.
  test("survives a half-written file", async () => {
    const dir = deployment({ "deployment.json": "{ not json", "secrets.json": "{}" })
    expect(await readDeployment(dir)).toBeUndefined()
  })
})

describe("studioDeploymentDir", () => {
  // Must match local_runtime.rs: app_data_dir() + "personal-local" +
  // "deployment", where app_data_dir is Tauri's per-identifier directory.
  test("points at Studio's app data on each platform", () => {
    expect(studioDeploymentDir("darwin", "/Users/u")).toBe(
      "/Users/u/Library/Application Support/com.exasol.studio/personal-local/deployment",
    )
    expect(studioDeploymentDir("linux", "/home/u")).toContain("com.exasol.studio/personal-local/deployment")
  })

  // Reading Studio's deployment is what lets a database installed there be
  // used from the CLI before Studio has published it to the shared registry.
  test("is a different directory from the launcher's", () => {
    expect(studioDeploymentDir("darwin", "/Users/u")).not.toContain(".exasol/personal/deployments")
  })
})

describe("credentialsFor", () => {
  const previous = process.env["EXASOL_DEPLOYMENTS_DIR"]
  afterEach(() => {
    if (previous === undefined) delete process.env["EXASOL_DEPLOYMENTS_DIR"]
    else process.env["EXASOL_DEPLOYMENTS_DIR"] = previous
  })

  function deployments(entries: Record<string, { port: number; password: string; host?: string }>) {
    const root = mkdtempSync(nodePath.join(tmpdir(), "exa-deployments-"))
    for (const [name, spec] of Object.entries(entries)) {
      const dir = nodePath.join(root, name)
      mkdirSync(dir)
      writeFileSync(
        nodePath.join(dir, "deployment.json"),
        JSON.stringify({
          deploymentState: "running",
          connection: { host: spec.host ?? "127.0.0.1", dbPort: spec.port, username: "sys" },
        }),
      )
      writeFileSync(nodePath.join(dir, "secrets.json"), JSON.stringify({ dbPassword: spec.password }))
    }
    process.env["EXASOL_DEPLOYMENTS_DIR"] = root
  }

  test("finds the deployment listening on that port", async () => {
    deployments({ default: { port: 8563, password: "one" }, other: { port: 8570, password: "two" } })
    expect((await credentialsFor("127.0.0.1", 8570))!.password).toBe("two")
  })

  // Discovery reports 127.0.0.1 while the launcher may have written
  // "localhost"; the same machine must not read as a different one.
  test("treats the loopback names as the same host", async () => {
    deployments({ default: { port: 8563, password: "one", host: "localhost" } })
    expect(await credentialsFor("127.0.0.1", 8563)).toBeDefined()
  })

  test("does not hand a local password to a remote host", async () => {
    deployments({ default: { port: 8563, password: "one" } })
    expect(await credentialsFor("db.example.com", 8563)).toBeUndefined()
  })

  test("reports nothing for a port no deployment owns", async () => {
    deployments({ default: { port: 8563, password: "one" } })
    expect(await credentialsFor("127.0.0.1", 8565)).toBeUndefined()
  })

  test("reports nothing when the launcher was never run", async () => {
    process.env["EXASOL_DEPLOYMENTS_DIR"] = nodePath.join(tmpdir(), "exa-deployments-absent")
    expect(await listDeployments()).toEqual([])
    expect(await credentialsFor("127.0.0.1", 8563)).toBeUndefined()
  })
})
