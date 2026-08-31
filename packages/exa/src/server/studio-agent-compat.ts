/**
 * The agent-sidecar API for Exasol Studio's web build.
 *
 * In the desktop app, Studio's assistant panel talks to a small sidecar
 * (agent-core) at /v1/engine/*, which in turn drives the exa engine. In
 * `exa web` there is no sidecar — the page is served BY the engine — so the
 * panel's boot check (`/v1/engine/status`) had nothing to answer it and the
 * assistant sat on "STARTING EXA…" forever.
 *
 * This module answers that API from inside the engine itself, mirroring the
 * response shapes agent-core serves (packages/agent-core/src/server.ts in the
 * Studio repository). Chat itself never goes through here: once status
 * reports running with this server's port, the panel's runtime speaks the
 * engine's own session API directly.
 */

import path from "node:path"
import fs from "node:fs/promises"
import os from "node:os"
import crypto from "node:crypto"

type Json = Record<string, unknown> | unknown[] | null

/**
 * Dashboards, file-per-dashboard with embedded revisions — the same contract
 * as the desktop sidecar's DashboardStore, so saved dashboards behave
 * identically in the web build (System dashboards locked, 15 revisions).
 */
const dashDir = async () => {
  const dir = path.join(os.homedir(), ".exasol", "web-dashboards")
  await fs.mkdir(dir, { recursive: true })
  return dir
}
const sanitizeId = (id: string) => id.replace(/[^a-zA-Z0-9_-]/g, "_")

const dashboards = {
  async list() {
    const dir = await dashDir()
    const out: unknown[] = []
    for (const f of await fs.readdir(dir)) {
      if (!f.endsWith(".json")) continue
      try {
        const d = JSON.parse(await fs.readFile(path.join(dir, f), "utf8"))
        out.push({
          id: d.id,
          title: d.title,
          description: d.description ?? "",
          group: d.group,
          panels: Array.isArray(d.panels) ? d.panels.length : 0,
          updatedAt: d.updatedAt ?? 0,
        })
      } catch {
        /* skip corrupt file */
      }
    }
    return out
  },
  async get(id: string) {
    try {
      return JSON.parse(await fs.readFile(path.join(await dashDir(), `${sanitizeId(id)}.json`), "utf8"))
    } catch {
      return null
    }
  },
  async save(input: unknown) {
    const raw = (input ?? {}) as Record<string, any>
    if (!raw.id) raw.id = crypto.randomUUID().slice(0, 8)
    const existing = await this.get(String(raw.id))
    if (existing?.group === "System") throw new Error("System dashboards are read-only and cannot be modified")
    let revisions: unknown[] = []
    if (existing) {
      revisions = Array.isArray(existing.revisions) ? existing.revisions : []
      delete existing.revisions
      revisions.unshift(existing)
      revisions = revisions.slice(0, 15)
    }
    const doc = { ...raw, updatedAt: Date.now(), revisions }
    await fs.writeFile(path.join(await dashDir(), `${sanitizeId(String(raw.id))}.json`), JSON.stringify(doc, null, 2))
    const { revisions: _r, ...current } = doc
    return current
  },
  async history(id: string) {
    const doc = await this.get(id)
    return ((doc?.revisions ?? []) as any[]).map((r, index) => ({
      index,
      updatedAt: r.updatedAt ?? 0,
      title: r.title ?? "",
      panels: Array.isArray(r.panels) ? r.panels.length : 0,
    }))
  },
  async rollback(id: string, index: number) {
    const doc = await this.get(id)
    const rev = (doc?.revisions ?? [])[index]
    if (!rev) return null
    return this.save(rev)
  },
  async remove(id: string) {
    try {
      await fs.rm(path.join(await dashDir(), `${sanitizeId(id)}.json`))
      return true
    } catch {
      return false
    }
  },
}

export type CompatResult = { status: number; body: Json } | undefined

import { ServerAuth } from "./auth"

// In-process self-calls must pass the server's own auth (vault sessions or an
// env password). A minted session token covers both without any secret in
// transit beyond loopback.
let selfSession: string | undefined

async function engineFetch(base: string, path: string, init?: RequestInit): Promise<any> {
  selfSession ??= ServerAuth.issueSession()
  const headers = new Headers(init?.headers)
  headers.set("cookie", `exa_session=${selfSession}`)
  const res = await fetch(`${base}${path}`, { ...init, headers })
  if (!res.ok) throw new Error(`engine ${res.status} on ${path}`)
  const text = await res.text()
  return text ? JSON.parse(text) : null
}

/** Popular-first provider catalog, same slimming agent-core applies. */
const POPULAR = ["ollama", "lmstudio", "openai", "google", "openrouter", "anthropic", "groq", "github-copilot"]
let catalogCache: { at: number; providers: unknown[] } | null = null

async function catalog(): Promise<unknown[]> {
  const TTL = 10 * 60_000
  if (catalogCache && Date.now() - catalogCache.at < TTL) return catalogCache.providers
  const res = await fetch(process.env["EXA_MODELS_URL"]?.trim() || "https://models.dev/api.json", {
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) throw new Error(`catalog fetch failed: ${res.status}`)
  const raw = (await res.json()) as Record<string, { name?: string; env?: string[]; models?: Record<string, unknown> }>
  const out = Object.entries(raw)
    .filter(([, p]) => p && typeof p === "object")
    .map(([id, p]) => ({
      id,
      name: p.name ?? id,
      env: Array.isArray(p.env) ? p.env : [],
      modelCount: p.models ? Object.keys(p.models).length : 0,
      popular: POPULAR.includes(id),
    }))
    .sort((a, b) => {
      const pa = POPULAR.indexOf(a.id)
      const pb = POPULAR.indexOf(b.id)
      if (pa !== -1 || pb !== -1) return (pa === -1 ? POPULAR.length : pa) - (pb === -1 ? POPULAR.length : pb)
      return a.name.localeCompare(b.name)
    })
  catalogCache = { at: Date.now(), providers: out }
  return out
}

export async function handleAgentCompat(
  method: string,
  pathname: string,
  body: Record<string, unknown>,
  self: { port: number },
): Promise<CompatResult> {
  const parts = pathname.split("/").filter(Boolean) // ["v1", "engine", ...]
  if (parts[0] !== "v1") return undefined
  const base = `http://127.0.0.1:${self.port}`

  try {
    // GET /v1/models — the panel's PRIMARY provider list (the desktop sidecar
    // ranks Local Runtime → cloud). Built here from the engine's own catalog:
    // ollama and the built-in engine surface as running local providers, so
    // local models appear in the web picker exactly like on the desktop.
    if (method === "GET" && parts[1] === "models" && !parts[2]) {
      const r = await engineFetch(base, "/config/providers")
      const LOCAL = new Set(["ollama", "builtin", "lmstudio"])
      const providers = (r?.providers ?? []).map((p: any) => ({
        id: p.id,
        name: p.id === "builtin" ? "Exa engine (local)" : p.id === "ollama" ? "Ollama (local)" : (p.name ?? p.id),
        kind: LOCAL.has(p.id) ? "local" : "cloud",
        configured: true,
        // A local provider only appears in the engine's list when it was
        // actually detected/serving, so listing it as running is the truth.
        ...(LOCAL.has(p.id) ? { running: true } : {}),
        models: Object.entries(p.models ?? {}).map(([id, m]: [string, any]) => ({
          id,
          name: m?.name ?? id,
          context: m?.limit?.context,
          toolCall: m?.capabilities?.toolcall,
          variants: m?.variants ? Object.keys(m.variants) : undefined,
        })),
      }))
      const defaults = r?.default ?? {}
      const first = Object.entries(defaults)[0]
      return { status: 200, body: { providers, defaultModel: first ? `${first[0]}/${first[1]}` : null } }
    }

    if (parts[1] === "engine") {
      if (method === "GET" && parts[2] === "status") {
        // This server IS the engine — if this code runs, it is running.
        return { status: 200, body: { state: "running", binaryPresent: true, provisioned: true, port: self.port } }
      }

      if (method === "GET" && parts[2] === "providers") {
        const r = await engineFetch(base, "/config/providers")
        const providers = (r?.providers ?? []).map((p: any) => ({
          id: p.id,
          name: p.name ?? p.id,
          source: p.source,
          models: Object.entries(p.models ?? {}).map(([id, m]: [string, any]) => ({
            id,
            name: m?.name ?? id,
            context: m?.limit?.context,
            variants: m?.variants ? Object.keys(m.variants) : undefined,
          })),
        }))
        return { status: 200, body: { providers, defaults: r?.default ?? {} } }
      }

      if (method === "GET" && parts[2] === "catalog") {
        try {
          return { status: 200, body: { providers: await catalog() } }
        } catch {
          return { status: 502, body: { error: "catalog unavailable (offline?)" } }
        }
      }

      if (method === "POST" && parts[2] === "auth" && !parts[3]) {
        const providerId = String(body["providerId"] ?? "")
        const key = String(body["key"] ?? "")
        if (!providerId || !key) return { status: 400, body: { error: "providerId and key required" } }
        await engineFetch(base, `/auth/${encodeURIComponent(providerId)}`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ type: "api", key }),
        })
        return { status: 200, body: { ok: true } }
      }
      if (method === "DELETE" && parts[2] === "auth" && parts[3]) {
        await engineFetch(base, `/auth/${encodeURIComponent(parts[3])}`, { method: "DELETE" })
        return { status: 200, body: { ok: true } }
      }

      if (method === "GET" && parts[2] === "auth-methods") {
        return { status: 200, body: { methods: await engineFetch(base, "/provider/auth") } }
      }
      if (method === "GET" && parts[2] === "connected") {
        const r = await engineFetch(base, "/provider")
        return { status: 200, body: { connected: r?.connected ?? [] } }
      }

      if (method === "POST" && parts[2] === "oauth" && parts[3] === "authorize") {
        const providerId = String(body["providerId"] ?? "")
        const authorization = await engineFetch(base, `/provider/${encodeURIComponent(providerId)}/oauth/authorize`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ method: body["method"], ...(body["inputs"] ? { inputs: body["inputs"] } : {}) }),
        })
        return { status: 200, body: { authorization } }
      }
      if (method === "POST" && parts[2] === "oauth" && parts[3] === "callback") {
        const providerId = String(body["providerId"] ?? "")
        const ok = await engineFetch(base, `/provider/${encodeURIComponent(providerId)}/oauth/callback`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ method: body["method"], ...(body["code"] ? { code: body["code"] } : {}) }),
        })
        return ok === true
          ? { status: 200, body: { ok: true } }
          : { status: 502, body: { error: "authorization was not completed" } }
      }

      if (parts[2] === "network" && !parts[3]) {
        if (method === "GET") {
          // The engine's merged ruleset is the enforced truth.
          const agents = await engineFetch(base, "/agent")
          const exa = (agents ?? []).find((a: any) => a.name === "exa")
          const rules = (exa?.permission ?? []).filter((r: any) => r.permission === "webfetch")
          const allowed = rules.length === 0 ? true : rules[rules.length - 1].action !== "deny"
          return { status: 200, body: { allowed, live: true } }
        }
        if (method === "POST") {
          // The engine's own global-config API: writes the winning config
          // file (jsonc-aware), invalidates the config cache, and disposes
          // every instance — the very mechanism `exa sandbox` lacks a running
          // server for. Then verify against the LIVE merged rules.
          const want = Boolean(body["allow"])
          const action = want ? "allow" : "deny"
          await engineFetch(base, "/global/config", {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ agent: { exa: { permission: { webfetch: action, websearch: action } } } }),
          })
          const enforced = async () => {
            const agents = await engineFetch(base, "/agent")
            const exa = (agents ?? []).find((a: any) => a.name === "exa")
            const rules = (exa?.permission ?? []).filter((r: any) => r.permission === "webfetch")
            return rules.length === 0 ? true : rules[rules.length - 1].action !== "deny"
          }
          let verified = false
          for (let attempt = 0; attempt < 10 && !verified; attempt++) {
            await new Promise((r) => setTimeout(r, 300))
            verified = (await enforced().catch(() => !want)) === want
          }
          return { status: 200, body: { ok: true, verified } }
        }
        return { status: 404, body: { error: "not found" } }
      }

      if (method === "GET" && parts[2] === "sessions" && !parts[3]) {
        const r = await engineFetch(base, "/session")
        const sessions = (r ?? []).map((s: any) => ({ id: s.id, title: s.title, updated: s.time?.updated }))
        return { status: 200, body: { sessions } }
      }
      if (method === "DELETE" && parts[2] === "sessions" && parts[3] && !parts[4]) {
        await engineFetch(base, `/session/${encodeURIComponent(parts[3])}`, { method: "DELETE" })
        return { status: 200, body: { ok: true } }
      }
      if (method === "POST" && parts[2] === "sessions" && parts[3] && parts[4] === "rename") {
        const title = String(body["title"] ?? "").trim()
        if (!title) return { status: 400, body: { error: "title required" } }
        await engineFetch(base, `/session/${encodeURIComponent(parts[3])}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title }),
        })
        return { status: 200, body: { ok: true } }
      }
      if (method === "POST" && parts[2] === "sessions" && parts[3] && parts[4]) {
        const sid = encodeURIComponent(parts[3])
        const op =
          parts[4] === "compact" ? "summarize" : parts[4] === "undo" ? "revert" : parts[4] === "redo" ? "unrevert" : null
        if (!op) return { status: 404, body: { error: "not found" } }
        await engineFetch(base, `/session/${sid}/${op}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        })
        return { status: 200, body: { ok: true } }
      }

      if (method === "GET" && parts[2] === "mcp" && !parts[3]) {
        return { status: 200, body: { servers: (await engineFetch(base, "/mcp")) ?? {} } }
      }

      return { status: 404, body: { error: "not found" } }
    }

    // ── Dashboards: same routes and semantics as the desktop sidecar ──
    if (parts[1] === "dashboards") {
      if (method === "GET" && !parts[2]) return { status: 200, body: { dashboards: await dashboards.list() } }
      if (method === "GET" && parts[2] && parts[3] === "history") {
        return { status: 200, body: { history: await dashboards.history(decodeURIComponent(parts[2])) } }
      }
      if (method === "POST" && parts[2] && parts[3] === "rollback") {
        const d = await dashboards.rollback(decodeURIComponent(parts[2]), Number(body["index"] ?? 0))
        return d ? { status: 200, body: { dashboard: d } } : { status: 404, body: { error: "no such revision" } }
      }
      if (method === "GET" && parts[2]) {
        const d = await dashboards.get(decodeURIComponent(parts[2]))
        return d ? { status: 200, body: { dashboard: d } } : { status: 404, body: { error: "not found" } }
      }
      if (method === "PUT") {
        try {
          return { status: 200, body: { dashboard: await dashboards.save(body) } }
        } catch (e) {
          return { status: 400, body: { error: e instanceof Error ? e.message : String(e) } }
        }
      }
      if (method === "DELETE" && parts[2]) {
        return { status: (await dashboards.remove(decodeURIComponent(parts[2]))) ? 200 : 404, body: { ok: true } }
      }
    }

    // Artifacts: none stored web-side yet — an empty list, not an error.
    if (method === "GET" && parts[1] === "artifacts" && !parts[2]) return { status: 200, body: { artifacts: [] } }

    // Anything else under /v1 belongs to the desktop sidecar.
    return { status: 501, body: { error: `"${pathname}" needs the desktop app's agent sidecar.` } }
  } catch (error) {
    return { status: 502, body: { error: error instanceof Error ? error.message : String(error) } }
  }
}
