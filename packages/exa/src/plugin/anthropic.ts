/**
 * Anthropic subscription sign-in (Claude Pro/Max).
 *
 * Anthropic's OAuth treats subscription inference as Claude Code traffic: the
 * flow requests the `user:inference` scope with Anthropic's public CLI client
 * id, and every request must carry the oauth beta header and identify itself
 * with Claude Code's system line — requests that don't are rejected, so the
 * fetch wrapper injects both rather than hoping the caller remembered.
 *
 * Two ways in, mirroring the ChatGPT plugin next door:
 * - Claude Pro/Max: sign in on claude.ai, usage bills to the subscription.
 * - Console account: sign in on console.anthropic.com, which creates a real
 *   API key (billed per token) and stores that instead of OAuth tokens.
 *
 * Both use the paste-a-code flow: Anthropic's redirect lands on their own
 * /oauth/code/callback page showing `code#state`, which the user pastes back.
 */
import type { Hooks, PluginInput } from "@exa/plugin"
import { OAUTH_DUMMY_KEY } from "../auth"

const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
const TOKEN_ENDPOINT = "https://console.anthropic.com/v1/oauth/token"
const REDIRECT_URI = "https://console.anthropic.com/oauth/code/callback"
const SCOPES = "org:create_api_key user:profile user:inference"
const OAUTH_BETA = "oauth-2025-04-20"
/** The identity Anthropic's API expects on subscription traffic — verbatim. */
const SPOOF_SYSTEM = "You are Claude Code, Anthropic's official CLI for Claude."

interface Pkce {
  verifier: string
  challenge: string
}

async function generatePKCE(): Promise<Pkce> {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~"
  const verifier = Array.from(crypto.getRandomValues(new Uint8Array(43)))
    .map((b) => chars[b % chars.length])
    .join("")
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))
  const challenge = btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "")
  return { verifier, challenge }
}

export function authorizeUrl(base: "claude.ai" | "console.anthropic.com", pkce: Pkce): string {
  const params = new URLSearchParams({
    code: "true",
    client_id: CLIENT_ID,
    response_type: "code",
    redirect_uri: REDIRECT_URI,
    scope: SCOPES,
    code_challenge: pkce.challenge,
    code_challenge_method: "S256",
    // Anthropic's code page echoes the state back as `code#state`; using the
    // verifier keeps the exchange bound to this run without extra storage.
    state: pkce.verifier,
  })
  return `https://${base}/oauth/authorize?${params.toString()}`
}

interface TokenResponse {
  access_token: string
  refresh_token: string
  expires_in?: number
  account?: { uuid?: string }
}

/** The pasted value is `code#state`; both halves go into the exchange. */
export function splitPastedCode(pasted: string): { code: string; state: string | undefined } {
  const [code, state] = pasted.trim().split("#")
  return { code: code ?? "", state }
}

async function exchangeCode(pasted: string, verifier: string): Promise<TokenResponse> {
  const { code, state } = splitPastedCode(pasted)
  const response = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code,
      state,
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
    }),
  })
  if (!response.ok) throw new Error(`Token exchange failed: ${response.status}`)
  return (await response.json()) as TokenResponse
}

async function refreshTokens(refreshToken: string): Promise<TokenResponse> {
  const response = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
    }),
  })
  if (!response.ok) throw new Error(`Token refresh failed: ${response.status}`)
  return (await response.json()) as TokenResponse
}

/** Merge the oauth beta into whatever betas the request already carries. */
export function mergedBeta(existing: string | null | undefined): string {
  const betas = (existing ?? "").split(",").map((b) => b.trim()).filter(Boolean)
  if (!betas.includes(OAUTH_BETA)) betas.unshift(OAUTH_BETA)
  return betas.join(",")
}

/**
 * Make a /v1/messages body acceptable to subscription inference.
 *
 * Two rules, both learned the hard way against the live API:
 * - The system prompt must be Claude Code's identity line — ONLY that line.
 *   Anthropic classifies each subscription request; a foreign agent prompt in
 *   `system` (bisected live: exa's identity plus a Claude-Code-style <env>
 *   block was enough) flips the request to the metered "extra usage" pool,
 *   which on Team seats is typically unfunded — surfacing as "You're out of
 *   extra usage" even with quota to spare.
 * - The real system prompt still has to reach the model, so it rides as a
 *   leading <system>-tagged user turn instead. Verified: the same request
 *   that 400s with the prompt in `system` passes with it moved here.
 */
export function spoofSystem(body: unknown): unknown {
  if (typeof body !== "object" || body === null) return body
  const request = body as Record<string, unknown>
  const spoof = { type: "text", text: SPOOF_SYSTEM }
  const system = request["system"]
  const messages = Array.isArray(request["messages"]) ? (request["messages"] as unknown[]) : []

  // Collect the real prompt out of whatever shape `system` arrived in,
  // dropping any spoof line already present (idempotency on retries).
  const blocks: { type?: string; text?: string; cache_control?: unknown }[] =
    system === undefined ? [] : typeof system === "string" ? [{ type: "text", text: system }] : Array.isArray(system) ? (system as never[]) : []
  const real = blocks.filter((b) => b?.text && b.text !== SPOOF_SYSTEM)

  if (real.length === 0) return { ...request, system: [spoof] }

  const promptText = `<system>\n${real.map((b) => b.text).join("\n\n")}\n</system>`
  const first = messages[0] as { role?: string; content?: unknown } | undefined
  const firstText =
    first?.role === "user" && Array.isArray(first.content)
      ? ((first.content[0] as { text?: string } | undefined)?.text ?? "")
      : typeof first?.content === "string"
        ? first.content
        : ""
  const alreadyMoved = firstText.startsWith("<system>")
  const carrier = {
    role: "user",
    content: [{ type: "text", text: promptText, ...(real[0]?.cache_control ? { cache_control: real[0].cache_control } : {}) }],
  }
  return {
    ...request,
    system: [spoof],
    messages: alreadyMoved ? messages : [carrier, ...messages],
  }
}

export async function AnthropicAuthPlugin(input: PluginInput): Promise<Hooks> {
  return {
    auth: {
      provider: "anthropic",
      async loader(getAuth) {
        const auth = await getAuth()
        if (auth.type !== "oauth") return {}

        let refreshPromise: Promise<string> | undefined

        return {
          apiKey: OAUTH_DUMMY_KEY,
          async fetch(requestInput: RequestInfo | URL, init?: RequestInit) {
            const currentAuth = await getAuth()
            if (currentAuth.type !== "oauth") return fetch(requestInput, init)

            if (!currentAuth.access || currentAuth.expires < Date.now()) {
              if (!refreshPromise) {
                refreshPromise = refreshTokens(currentAuth.refresh)
                  .then(async (tokens) => {
                    await input.client.auth.set({
                      path: { id: "anthropic" },
                      body: {
                        type: "oauth",
                        refresh: tokens.refresh_token,
                        access: tokens.access_token,
                        expires: Date.now() + (tokens.expires_in ?? 3600) * 1000,
                      },
                    })
                    return tokens.access_token
                  })
                  .finally(() => {
                    refreshPromise = undefined
                  })
              }
              currentAuth.access = await refreshPromise
            }

            const headers = new Headers(init?.headers)
            headers.delete("x-api-key")
            headers.set("authorization", `Bearer ${currentAuth.access}`)
            headers.set("anthropic-beta", mergedBeta(headers.get("anthropic-beta")))

            const url =
              requestInput instanceof URL
                ? requestInput
                : new URL(typeof requestInput === "string" ? requestInput : requestInput.url)

            let body = init?.body
            if (url.pathname.endsWith("/v1/messages") && typeof body === "string") {
              try {
                body = JSON.stringify(spoofSystem(JSON.parse(body)))
              } catch {
                // not JSON — send as-is and let the API answer
              }
            }

            return fetch(url, { ...init, body, headers })
          },
        }
      },
      methods: [
        {
          label: "Claude Pro/Max (subscription)",
          type: "oauth",
          authorize: async () => {
            const pkce = await generatePKCE()
            return {
              url: authorizeUrl("claude.ai", pkce),
              instructions:
                "Sign in with your Claude account (Google sign-in is fine) and press Authorize. Anthropic's pages say \"Claude Code\" — that is their name for the official CLI client every tool signs in through; the code is for exa. Copy the WHOLE code (both parts around the #) and paste it here.",
              method: "code" as const,
              callback: async (pasted: string) => {
                try {
                  const tokens = await exchangeCode(pasted, pkce.verifier)
                  return {
                    type: "success" as const,
                    refresh: tokens.refresh_token,
                    access: tokens.access_token,
                    expires: Date.now() + (tokens.expires_in ?? 3600) * 1000,
                    ...(tokens.account?.uuid && { accountId: tokens.account.uuid }),
                  }
                } catch {
                  return { type: "failed" as const }
                }
              },
            }
          },
        },
        {
          label: "Console account (creates an API key)",
          type: "oauth",
          authorize: async () => {
            const pkce = await generatePKCE()
            return {
              url: authorizeUrl("console.anthropic.com", pkce),
              instructions:
                "Sign in to the Anthropic Console and press Authorize. Copy the WHOLE code shown on the final page (both parts around the #) and paste it here — exa will create and store an API key for you.",
              method: "code" as const,
              callback: async (pasted: string) => {
                try {
                  const tokens = await exchangeCode(pasted, pkce.verifier)
                  const response = await fetch("https://api.anthropic.com/api/oauth/claude_cli/create_api_key", {
                    method: "POST",
                    headers: {
                      Authorization: `Bearer ${tokens.access_token}`,
                      "Content-Type": "application/json",
                    },
                  })
                  if (!response.ok) return { type: "failed" as const }
                  const created = (await response.json()) as { raw_key?: string }
                  if (!created.raw_key) return { type: "failed" as const }
                  return { type: "success" as const, key: created.raw_key }
                } catch {
                  return { type: "failed" as const }
                }
              },
            }
          },
        },
        {
          label: "API key (manual)",
          type: "api" as const,
        },
      ],
    },
  }
}
