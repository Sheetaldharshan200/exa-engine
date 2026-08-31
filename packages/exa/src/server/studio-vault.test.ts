import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import * as vault from "./studio-vault"

let dir: string | undefined
function freshFile() {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "exa-vault-"))
  return path.join(dir, "web-vault.json")
}

afterEach(() => {
  vault.lock()
  if (dir) fs.rmSync(dir, { recursive: true, force: true })
  dir = undefined
})

const PASSWORD = "correct horse 42"

describe("the full first-run flow Studio drives", () => {
  test("setup, lock, unlock", () => {
    const file = freshFile()
    expect(vault.status(file)).toEqual({ configured: false, unlocked: false, recoveryRemaining: 0 })

    const codes = vault.setup(PASSWORD, file)
    expect(codes).toHaveLength(5)
    expect(vault.status(file)).toEqual({ configured: true, unlocked: true, recoveryRemaining: 5 })

    vault.lock()
    expect(vault.status(file).unlocked).toBe(false)

    expect(vault.unlock(PASSWORD, file)).toBe(true)
    expect(vault.status(file).unlocked).toBe(true)
  })

  // Setting up twice would silently discard the recovery codes the user wrote
  // down, so it must refuse with the same message the desktop app uses.
  test("refuses a second setup", () => {
    const file = freshFile()
    vault.setup(PASSWORD, file)
    expect(() => vault.setup(PASSWORD, file)).toThrow("A master password is already set.")
  })

  test("a wrong password does not unlock", () => {
    const file = freshFile()
    vault.setup(PASSWORD, file)
    vault.lock()
    expect(() => vault.unlock("wrong password 1", file)).toThrow("Incorrect master password.")
    expect(vault.status(file).unlocked).toBe(false)
  })
})

describe("password rule (same as the desktop app)", () => {
  test("length, letter and digit are all required", () => {
    expect(vault.validatePassword("short1a")).toContain("at least 10")
    expect(vault.validatePassword("nodigitshere")).toContain("a letter and a number")
    expect(vault.validatePassword("1234567890123")).toContain("a letter and a number")
    expect(vault.validatePassword(PASSWORD)).toBeUndefined()
  })
})

describe("recovery", () => {
  // The person who lost their password has exactly these codes; each must
  // actually decrypt, and the used one must stop working.
  test("a recovery code resets the password and is consumed", () => {
    const file = freshFile()
    const codes = vault.setup(PASSWORD, file)
    vault.lock()

    const remaining = vault.recover(codes[2]!, "new password 99", file)
    expect(remaining).toBe(4)
    expect(vault.status(file)).toEqual({ configured: true, unlocked: true, recoveryRemaining: 4 })

    vault.lock()
    expect(vault.unlock("new password 99", file)).toBe(true)
    expect(() => vault.unlock(PASSWORD, file)).toThrow("Incorrect master password.")
    expect(() => vault.recover(codes[2]!, "another pass 7", file)).toThrow("Invalid recovery key.")
  })

  test("codes are accepted case-insensitively and trimmed", () => {
    const file = freshFile()
    const codes = vault.setup(PASSWORD, file)
    expect(vault.recover(`  ${codes[0]!.toLowerCase()}  `, "new password 99", file)).toBe(4)
  })

  test("regeneration invalidates the old codes", () => {
    const file = freshFile()
    const oldCodes = vault.setup(PASSWORD, file)
    const newCodes = vault.regenerateRecovery(file)
    expect(newCodes).toHaveLength(5)
    expect(vault.status(file).recoveryRemaining).toBe(5)
    expect(() => vault.recover(oldCodes[0]!, "new password 99", file)).toThrow("Invalid recovery key.")
    expect(vault.recover(newCodes[0]!, "new password 99", file)).toBe(4)
  })

  test("regeneration requires an unlocked vault", () => {
    const file = freshFile()
    vault.setup(PASSWORD, file)
    vault.lock()
    expect(() => vault.regenerateRecovery(file)).toThrow("Unlock the vault first.")
  })

  test("codes read like the desktop app's: 5 groups of 5, no ambiguous characters", () => {
    const code = vault.formatRecoveryCode()
    expect(code).toMatch(/^[A-HJ-NP-Z2-9]{5}(-[A-HJ-NP-Z2-9]{5}){4}$/)
  })
})

describe("changing the password", () => {
  test("requires the current one and keeps recovery codes valid", () => {
    const file = freshFile()
    const codes = vault.setup(PASSWORD, file)

    expect(() => vault.changePassword("wrong password 1", "next password 5", file)).toThrow(
      "Incorrect current password.",
    )
    vault.changePassword(PASSWORD, "next password 5", file)
    vault.lock()
    expect(vault.unlock("next password 5", file)).toBe(true)
    // The DEK is unchanged, so codes issued before the change still work.
    expect(vault.recover(codes[0]!, "third password 9", file)).toBe(4)
  })
})

describe("the file on disk", () => {
  test("holds no plaintext of the password, marker or codes", () => {
    const file = freshFile()
    const codes = vault.setup(PASSWORD, file)
    const raw = fs.readFileSync(file, "utf8")
    expect(raw).not.toContain(PASSWORD)
    for (const code of codes) expect(raw).not.toContain(code)
    expect(raw).not.toContain("exa-studio-web-vault-v1")
  })

  test("unlock survives a fresh process (state only in the file)", () => {
    const file = freshFile()
    vault.setup(PASSWORD, file)
    vault.lock() // simulate restart: in-memory key gone, file remains
    expect(vault.status(file)).toEqual({ configured: true, unlocked: false, recoveryRemaining: 5 })
    expect(vault.unlock(PASSWORD, file)).toBe(true)
  })
})
