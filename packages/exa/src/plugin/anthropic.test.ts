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
  type Out = { system: { text: string }[]; messages: { role: string; content: { type: string; text: string }[] }[] }

  // Anthropic classifies subscription requests by their system prompt: a
  // foreign agent prompt there flips the request into the metered "extra
  // usage" pool (bisected live against the API). So `system` must carry ONLY
  // Claude Code's identity, with the real prompt riding as a user turn.
  test("system carries only the identity; the real prompt becomes a user turn", () => {
    const out = spoofSystem({ system: [{ type: "text", text: "You are exa." }], messages: [{ role: "user", content: "hi" }] }) as Out
    expect(out.system.map((s) => s.text)).toEqual([SPOOF])
    expect(out.messages[0]!.role).toBe("user")
    expect(out.messages[0]!.content[0]!.text).toBe("<system>\nYou are exa.\n</system>")
    expect(out.messages[1]).toEqual({ role: "user", content: "hi" } as never)
  })

  test("a string system prompt moves the same way", () => {
    const out = spoofSystem({ system: "You are exa.", messages: [] }) as Out
    expect(out.system.map((s) => s.text)).toEqual([SPOOF])
    expect(out.messages[0]!.content[0]!.text).toContain("You are exa.")
  })

  test("multiple system blocks are joined in order", () => {
    const out = spoofSystem({ system: [{ type: "text", text: "A" }, { type: "text", text: "B" }], messages: [] }) as Out
    expect(out.messages[0]!.content[0]!.text).toBe("<system>\nA\n\nB\n</system>")
  })

  test("adds the identity when the request has no system at all", () => {
    const out = spoofSystem({ messages: [] }) as Out
    expect(out.system.map((s) => s.text)).toEqual([SPOOF])
    expect(out.messages).toEqual([])
  })

  test("is idempotent — a retried request is not double-wrapped", () => {
    const once = spoofSystem({ system: [{ type: "text", text: "You are exa." }], messages: [{ role: "user", content: "hi" }] })
    const twice = spoofSystem(once) as Out
    expect(twice.system.map((s) => s.text)).toEqual([SPOOF])
    expect(twice.messages).toHaveLength(2)
  })

  test("a cache_control on the original system block survives the move", () => {
    const out = spoofSystem({
      system: [{ type: "text", text: "You are exa.", cache_control: { type: "ephemeral" } }],
      messages: [],
    }) as { messages: { content: { cache_control?: { type: string } }[] }[] }
    expect(out.messages[0]!.content[0]!.cache_control).toEqual({ type: "ephemeral" })
  })

  test("leaves everything else in the request untouched", () => {
    const out = spoofSystem({ system: "x", messages: [], model: "claude-sonnet-4-5", max_tokens: 32000 }) as Record<string, unknown>
    expect(out["model"]).toBe("claude-sonnet-4-5")
    expect(out["max_tokens"]).toBe(32000)
  })
})
