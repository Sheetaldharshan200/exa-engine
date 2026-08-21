export * as ServerAuth from "./auth"

import { ConfigService } from "@/effect/config-service"
import { Flag } from "@exa/core/flag/flag"
import { Config as EffectConfig, Context, Option, Redacted } from "effect"
import { existsSync } from "node:fs"
import { createHash, randomBytes } from "node:crypto"
import * as StudioVault from "./studio-vault"

export type Credentials = {
  password?: string
  username?: string
}

export type DecodedCredentials = {
  readonly username: string
  readonly password: Redacted.Redacted
}

export class Config extends ConfigService.Service<Config>()("@exa/ServerAuthConfig", {
  password: EffectConfig.string("EXA_SERVER_PASSWORD").pipe(EffectConfig.option),
  username: EffectConfig.string("EXA_SERVER_USERNAME").pipe(EffectConfig.withDefault("exa")),
}) {}

export type Info = Context.Service.Shape<typeof Config>

// ── The master-password vault doubles as the server's credential ────────────
//
// One password, one sign-in: when no EXA_SERVER_PASSWORD is set but the web
// vault exists, HTTP basic auth verifies against the vault instead — and a
// successful sign-in also unlocks the vault in memory, so the app opens
// without asking for the same password a second time. An explicit
// EXA_SERVER_PASSWORD always wins (the operator chose it).

let vaultProbe: { at: number; configured: boolean } | undefined
/** Accepted passwords this process, by digest — scrypt runs once per browser
 *  session, not once per asset request. Only successes are cached. */
const accepted = new Set<string>()

function vaultConfigured(): boolean {
  const now = Date.now()
  if (vaultProbe && now - vaultProbe.at < 5_000) return vaultProbe.configured
  let configured = false
  try {
    configured = existsSync(StudioVault.vaultFile())
  } catch {
    configured = false
  }
  vaultProbe = { at: now, configured }
  return configured
}

function vaultAccepts(password: string): boolean {
  const digest = createHash("sha256").update(password).digest("hex")
  if (accepted.has(digest)) return true
  try {
    StudioVault.unlock(password) // throws on a wrong password; also unlocks the app
    accepted.add(digest)
    return true
  } catch {
    return false
  }
}

/** True when protection comes from the vault (no explicit env password). */
export function usingVaultAuth(config: Info) {
  return !(Option.isSome(config.password) && config.password.value !== "") && vaultConfigured()
}

// ── Browser sessions (vault mode) ────────────────────────────────────────────
// The app's own unlock screen is the door: a successful vault unlock issues a
// session token cookie, so the browser never sees the native basic-auth
// dialog. Tokens live in process memory — a server restart signs everyone out,
// which is exactly what a restart should do.
const sessions = new Set<string>()

export function issueSession(): string {
  const token = randomBytes(32).toString("base64url")
  sessions.add(token)
  return token
}

export function sessionValid(token: string | undefined): boolean {
  return token !== undefined && sessions.has(token)
}

export function sessionFromCookie(cookieHeader: string | undefined): string | undefined {
  if (!cookieHeader) return undefined
  for (const part of cookieHeader.split(";")) {
    const [name, ...rest] = part.trim().split("=")
    if (name === "exa_session") return rest.join("=")
  }
  return undefined
}

export function required(config: Info) {
  if (Option.isSome(config.password) && config.password.value !== "") return true
  return vaultConfigured()
}

export function authorized(credentials: DecodedCredentials, config: Info) {
  if (Option.isSome(config.password)) {
    return credentials.username === config.username && Redacted.value(credentials.password) === config.password.value
  }
  return credentials.username === config.username && vaultAccepts(Redacted.value(credentials.password))
}

export function header(credentials?: Credentials) {
  const password = credentials?.password ?? Flag.EXA_SERVER_PASSWORD
  if (!password) return undefined

  const username = credentials?.username ?? Flag.EXA_SERVER_USERNAME ?? "exa"
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`
}

export function headers(credentials?: Credentials) {
  const authorization = header(credentials)
  if (!authorization) return undefined
  return { Authorization: authorization }
}
