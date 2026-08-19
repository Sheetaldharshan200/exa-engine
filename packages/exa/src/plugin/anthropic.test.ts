import { describe, expect, test } from "bun:test"
import { authorizeUrl, mergedBeta, splitPastedCode, spoofSystem } from "./anthropic"

const SPOOF = "You are Claude Code, Anthropic's official CLI for Claude."

describe("authorizeUrl", () => {
  const pkce = { verifier: "v".repeat(43), challenge: "c".repeat(43) }

  // Anthropic rejects the exchange if any of these differ, so the URL is the
  // contract — asserted field by field rather than as one brittle string.
  test("carries everything the token exchange will be checked against", () => {
    const url = new URL(authorizeUrl("claude.ai", pkce))
    expect(url.origin + url.pathname).toBe("https://claude.ai/oauth/authorize")
    expect(url.searchParams.get("client_id")).toBe("9d1c250a-e61b-44d9-88ed-5944d1962f5e")
    expect(url.searchParams.get("redirect_uri")).toBe("https://console.anthropic.com/oauth/code/callback")
    expect(url.searchParams.get("scope")).toBe("org:create_api_key user:profile user:inference")
    expect(url.searchParams.get("code_challenge")).toBe(pkce.challenge)
    expect(url.searchParams.get("code_challenge_method")).toBe("S256")
    expect(url.searchParams.get("state")).toBe(pkce.verifier)
    expect(url.searchParams.get("code")).toBe("true")
  })

  test("the console flow differs only in the host", () => {
    const max = new URL(authorizeUrl("claude.ai", pkce))
    const console_ = new URL(authorizeUrl("console.anthropic.com", pkce))
    expect(console_.host).toBe("console.anthropic.com")
    expect(console_.search).toBe(max.search)
  })
})

describe("splitPastedCode", () => {
  // Anthropic's code page shows `code#state` as one string to copy.
  test("splits code and state", () => {
    expect(splitPastedCode("abc123#mystate")).toEqual({ code: "abc123", state: "mystate" })
  })

  test("tolerates surrounding whitespace from the paste", () => {
    expect(splitPastedCode("  abc123#mystate\n")).toEqual({ code: "abc123", state: "mystate" })
  })

  test("a bare code has no state", () => {
    expect(splitPastedCode("abc123")).toEqual({ code: "abc123", state: undefined })
  })
})

describe("mergedBeta", () => {
  test("adds the oauth beta when none is set", () => {
    expect(mergedBeta(null)).toBe("oauth-2025-04-20")
    expect(mergedBeta(undefined)).toBe("oauth-2025-04-20")
  })

  // The provider layer already sends interleaved-thinking betas; losing them
  // would silently change model behavior mid-conversation.
  test("keeps the betas the request already carries", () => {
    expect(mergedBeta("interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14")).toBe(
      "oauth-2025-04-20,interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14",
    )
  })

  test("does not duplicate itself on retries", () => {
    expect(mergedBeta("oauth-2025-04-20,interleaved-thinking-2025-05-14")).toBe(
      "oauth-2025-04-20,interleaved-thinking-2025-05-14",
    )
  })
})

describe("spoofSystem", () => {
  // Subscription inference requires the first system block to be Claude
  // Code's identity line — without it the API refuses the request outright.
  test("prepends the identity to an existing system array", () => {
    const out = spoofSystem({ system: [{ type: "text", text: "You are exa." }], messages: [] }) as {
      system: { text: string }[]
    }
    expect(out.system[0]!.text).toBe(SPOOF)
    expect(out.system[1]!.text).toBe("You are exa.")
  })

  test("converts a string system prompt without losing it", () => {
    const out = spoofSystem({ system: "You are exa." }) as { system: { text: string }[] }
    expect(out.system.map((s) => s.text)).toEqual([SPOOF, "You are exa."])
  })

  test("adds a system array when the request has none", () => {
    const out = spoofSystem({ messages: [] }) as { system: { type: string; text: string }[] }
    expect(out.system).toEqual([{ type: "text", text: SPOOF }])
  })

  test("is idempotent — a retried request is not double-prefixed", () => {
    const once = spoofSystem({ system: [{ type: "text", text: "You are exa." }] })
    const twice = spoofSystem(once) as { system: unknown[] }
    expect(twice.system).toHaveLength(2)
  })

  test("leaves everything else in the request untouched", () => {
    const out = spoofSystem({ system: "x", model: "claude-sonnet-4-5", max_tokens: 32000 }) as Record<string, unknown>
    expect(out["model"]).toBe("claude-sonnet-4-5")
    expect(out["max_tokens"]).toBe(32000)
  })
})
