/**
 * Master-password vault for the Studio web build.
 *
 * Mirrors the desktop app's vault contract: a random 256-bit DEK wrapped by a
 * key derived from the master password and by keys derived from 5 one-time
 * recovery codes; AES-256-GCM everywhere; the DEK held in memory only while
 * unlocked. Studio's first-run flow requires this — the UI will not open
 * without a configured, unlocked vault — so the headless backend has to
 * answer these commands for real, not refuse them.
 *
 * The file is NOT shared with the desktop app's vault.json: the desktop
 * derives keys with Argon2id, which has no counterpart in the Bun/Node
 * standard library, so this vault uses scrypt and lives under its own name.
 * Each app keeps its own master password; both protect the same idea.
 *
 * exa's connection passwords live in the OS credential store, so this vault
 * currently guards access to the app rather than encrypting profile secrets —
 * the verifier still makes unlock a real check, not a formality.
 */
import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const MARKER = Buffer.from("exa-studio-web-vault-v1")
const RECOVERY_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789" // no ambiguous chars
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }

type RecoveryEntry = { salt: string; wrapped: string }

type Vault = {
  version: number
  kdf: "scrypt"
  salt: string
  verifier: string
  dekWrapped: string
  recovery: RecoveryEntry[]
}

export function vaultFile(env: NodeJS.ProcessEnv = process.env): string {
  if (env["EXA_STUDIO_VAULT_FILE"]) return env["EXA_STUDIO_VAULT_FILE"]
  const home = env["HOME"] ?? env["USERPROFILE"] ?? os.homedir()
  return path.join(home, ".exasol", "web-vault.json")
}

/** The unlocked DEK, per server process. */
let dekInMemory: Buffer | undefined

function loadVault(file: string): Vault | undefined {
  if (!fs.existsSync(file)) return undefined
  return JSON.parse(fs.readFileSync(file, "utf8")) as Vault
}

function saveVault(file: string, vault: Vault) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(vault, null, 2), { mode: 0o600 })
}

function deriveKey(secret: string, salt: Buffer): Buffer {
  return crypto.scryptSync(secret, salt, 32, SCRYPT)
}

/** AES-256-GCM; output is base64(nonce ‖ ciphertext ‖ tag). */
function seal(key: Buffer, plaintext: Buffer): string {
  const nonce = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce)
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()])
  return Buffer.concat([nonce, ct, cipher.getAuthTag()]).toString("base64")
}

function open(key: Buffer, data: string): Buffer | undefined {
  const raw = Buffer.from(data, "base64")
  if (raw.length < 12 + 16) return undefined
  const nonce = raw.subarray(0, 12)
  const tag = raw.subarray(raw.length - 16)
  const ct = raw.subarray(12, raw.length - 16)
  try {
    const cipher = crypto.createDecipheriv("aes-256-gcm", key, nonce)
    cipher.setAuthTag(tag)
    return Buffer.concat([cipher.update(ct), cipher.final()])
  } catch {
    return undefined // wrong key or corrupt data
  }
}

export function formatRecoveryCode(): string {
  const raw = crypto.randomBytes(25)
  const chars = [...raw].map((b) => RECOVERY_ALPHABET[b % RECOVERY_ALPHABET.length])
  const groups: string[] = []
  for (let i = 0; i < 25; i += 5) groups.push(chars.slice(i, i + 5).join(""))
  return groups.join("-")
}

function makeRecovery(dek: Buffer): { codes: string[]; entries: RecoveryEntry[] } {
  const codes: string[] = []
  const entries: RecoveryEntry[] = []
  for (let i = 0; i < 5; i++) {
    const code = formatRecoveryCode()
    const salt = crypto.randomBytes(16)
    entries.push({ salt: salt.toString("base64"), wrapped: seal(deriveKey(code, salt), dek) })
    codes.push(code)
  }
  return { codes, entries }
}

/** Same rule and same message as the desktop app. */
export function validatePassword(pw: string): string | undefined {
  const okLen = [...pw].length >= 10
  const hasAlpha = /\p{L}/u.test(pw)
  const hasDigit = /[0-9]/.test(pw)
  if (!okLen || !hasAlpha || !hasDigit) {
    return "Master password must be at least 10 characters and include a letter and a number."
  }
  return undefined
}

export type VaultStatus = { configured: boolean; unlocked: boolean; recoveryRemaining: number }

export function status(file = vaultFile()): VaultStatus {
  const vault = loadVault(file)
  return {
    configured: vault !== undefined,
    unlocked: dekInMemory !== undefined,
    recoveryRemaining: vault?.recovery.length ?? 0,
  }
}

/** Create the vault. Returns the 5 recovery codes (shown once, never stored). */
export function setup(password: string, file = vaultFile()): string[] {
  if (loadVault(file) !== undefined) throw new Error("A master password is already set.")
  const invalid = validatePassword(password)
  if (invalid) throw new Error(invalid)

  const dek = crypto.randomBytes(32)
  const salt = crypto.randomBytes(16)
  const kek = deriveKey(password, salt)
  const { codes, entries } = makeRecovery(dek)
  saveVault(file, {
    version: 1,
    kdf: "scrypt",
    salt: salt.toString("base64"),
    verifier: seal(kek, MARKER),
    dekWrapped: seal(kek, dek),
    recovery: entries,
  })
  dekInMemory = dek
  return codes
}

export function unlock(password: string, file = vaultFile()): boolean {
  const vault = loadVault(file)
  if (!vault) throw new Error("No master password is set.")
  const kek = deriveKey(password, Buffer.from(vault.salt, "base64"))
  const marker = open(kek, vault.verifier)
  if (!marker || !marker.equals(MARKER)) throw new Error("Incorrect master password.")
  const dek = open(kek, vault.dekWrapped)
  if (!dek) throw new Error("Incorrect master password.")
  dekInMemory = dek
  return true
}

export function lock() {
  dekInMemory = undefined
}

/** Reset the master password using one recovery code; the used code is consumed. */
export function recover(code: string, newPassword: string, file = vaultFile()): number {
  const invalid = validatePassword(newPassword)
  if (invalid) throw new Error(invalid)
  const vault = loadVault(file)
  if (!vault) throw new Error("No master password is set.")
  const normalized = code.trim().toUpperCase()

  let found: { index: number; dek: Buffer } | undefined
  for (let i = 0; i < vault.recovery.length; i++) {
    const entry = vault.recovery[i]!
    const dek = open(deriveKey(normalized, Buffer.from(entry.salt, "base64")), entry.wrapped)
    if (dek) {
      found = { index: i, dek }
      break
    }
  }
  if (!found) throw new Error("Invalid recovery key.")

  const salt = crypto.randomBytes(16)
  const kek = deriveKey(newPassword, salt)
  vault.salt = salt.toString("base64")
  vault.verifier = seal(kek, MARKER)
  vault.dekWrapped = seal(kek, found.dek)
  vault.recovery.splice(found.index, 1)
  saveVault(file, vault)
  dekInMemory = found.dek
  return vault.recovery.length
}

export function changePassword(oldPassword: string, newPassword: string, file = vaultFile()) {
  const invalid = validatePassword(newPassword)
  if (invalid) throw new Error(invalid)
  const vault = loadVault(file)
  if (!vault) throw new Error("No master password is set.")
  const oldKek = deriveKey(oldPassword, Buffer.from(vault.salt, "base64"))
  const dek = open(oldKek, vault.dekWrapped)
  if (!dek) throw new Error("Incorrect current password.")

  const salt = crypto.randomBytes(16)
  const kek = deriveKey(newPassword, salt)
  vault.salt = salt.toString("base64")
  vault.verifier = seal(kek, MARKER)
  vault.dekWrapped = seal(kek, dek)
  saveVault(file, vault)
}

/** Regenerate a fresh set of 5 recovery codes (invalidates the old ones). */
export function regenerateRecovery(file = vaultFile()): string[] {
  if (!dekInMemory) throw new Error("Unlock the vault first.")
  const vault = loadVault(file)
  if (!vault) throw new Error("No master password is set.")
  const { codes, entries } = makeRecovery(dekInMemory)
  vault.recovery = entries
  saveVault(file, vault)
  return codes
}
