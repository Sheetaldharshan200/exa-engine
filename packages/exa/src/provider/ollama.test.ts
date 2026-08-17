import { describe, expect, test } from "bun:test"
import { detect, parseShow, parseTags, toModel } from "./ollama"

describe("parseTags", () => {
  // The shape a real `GET /api/tags` returns.
  test("reads the ids the OpenAI-compatible API expects", () => {
    expect(
      parseTags({
        models: [
          { name: "qwen2.5:0.5b", model: "qwen2.5:0.5b" },
          { name: "llama3.2:latest", model: "llama3.2:latest" },
        ],
      }),
    ).toEqual(["qwen2.5:0.5b", "llama3.2:latest"])
  })

  // Running with nothing pulled is a real state, and must not look like an
  // error — otherwise `ollama pull` appears to have had no effect.
  test("an empty install is an empty list, not a failure", () => {
    expect(parseTags({ models: [] })).toEqual([])
  })

  test("survives a response that is not the shape we expect", () => {
    expect(parseTags(undefined)).toEqual([])
    expect(parseTags({})).toEqual([])
    expect(parseTags({ models: "nonsense" })).toEqual([])
  })
})

describe("parseShow", () => {
  // Recorded from `POST /api/show` for qwen2.5:0.5b on a real machine.
  test("reads tool calling and the context window", () => {
    const parsed = parseShow("qwen2.5:0.5b", {
      capabilities: ["completion", "tools"],
      model_info: { "qwen2.context_length": 32768, "qwen2.block_count": 24 },
    })
    expect(parsed).toEqual({ id: "qwen2.5:0.5b", toolcall: true, vision: false, context: 32768 })
  })

  // The key is named after the architecture, so it cannot be looked up by a
  // fixed name — a llama model reports llama.context_length.
  test("finds the context window whatever the architecture is called", () => {
    expect(parseShow("llama3.2", { model_info: { "llama.context_length": 131072 } }).context).toBe(131072)
    expect(parseShow("gemma3", { model_info: { "gemma3.context_length": 8192 } }).context).toBe(8192)
  })

  test("reads vision separately from tool calling", () => {
    const parsed = parseShow("llava", { capabilities: ["completion", "vision"] })
    expect(parsed.vision).toBe(true)
    expect(parsed.toolcall).toBe(false)
  })

  // A model that cannot call tools is close to useless to this agent, so the
  // flag must never be assumed true.
  test("does not assume tool calling", () => {
    expect(parseShow("x", { capabilities: ["completion"] }).toolcall).toBe(false)
    expect(parseShow("x", {}).toolcall).toBe(false)
    expect(parseShow("x", undefined).toolcall).toBe(false)
  })

  test("leaves the context unset when the server does not report one", () => {
    expect(parseShow("x", { model_info: {} }).context).toBeUndefined()
  })
})

describe("toModel", () => {
  test("points at the OpenAI-compatible endpoint", () => {
    const model = toModel({ id: "qwen2.5:0.5b", toolcall: true, vision: false, context: 32768 })
    expect(model.api.url).toBe("http://127.0.0.1:11434/v1")
    expect(model.api.npm).toBe("@ai-sdk/openai-compatible")
    expect(model.limit.context).toBe(32768)
  })

  // It runs on the user's own machine; any non-zero figure would be invented.
  test("costs nothing", () => {
    const model = toModel({ id: "x", toolcall: true, vision: false })
    expect(model.cost).toEqual({ input: 0, output: 0, cache: { read: 0, write: 0 } })
  })

  test("carries the detected capabilities through", () => {
    const vision = toModel({ id: "llava", toolcall: false, vision: true })
    expect(vision.capabilities.toolcall).toBe(false)
    expect(vision.capabilities.input.image).toBe(true)
    expect(vision.capabilities.attachment).toBe(true)
  })

  test("falls back to a conservative context when none was reported", () => {
    expect(toModel({ id: "x", toolcall: true, vision: false }).limit.context).toBe(8_192)
  })
})

describe("detect", () => {
  // Not running and running-with-nothing are different states: the first must
  // hide the provider, the second must show it as available but empty.
  test("reports nothing when no server is listening", async () => {
    expect(await detect("http://127.0.0.1:11499")).toBeUndefined()
  })
})
