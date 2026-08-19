import { FSUtil } from "@exa/core/fs-util"
import { Effect, Stream } from "effect"
import { HttpBody, HttpClient, HttpClientRequest, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { createHash } from "node:crypto"
import { ProxyUtil } from "../proxy-util"

let embeddedUIPromise: Promise<Record<string, string> | null> | undefined

/** Optional host serving the web UI. There is no default: the UI is served
 *  from the embedded bundle, and proxying to an outside host only happens
 *  when the operator names one via EXA_WEB_UI_UPSTREAM. */
export const UI_UPSTREAM = process.env["EXA_WEB_UI_UPSTREAM"]
  ? new URL(process.env["EXA_WEB_UI_UPSTREAM"])
  : undefined

export const csp = (hash = "") =>
  `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'${hash ? ` 'sha256-${hash}'` : ""}; style-src 'self' 'unsafe-inline'; img-src 'self' data: https: blob:; font-src 'self' data:; media-src 'self' data:; connect-src * data: blob:`
export const DEFAULT_CSP = csp()

export function themePreloadHash(body: string) {
  return body.match(/<script\b(?![^>]*\bsrc\s*=)[^>]*\bid=(['"])oc-theme-preload-script\1[^>]*>([\s\S]*?)<\/script>/i)
}

export function cspForHtml(body: string) {
  const match = themePreloadHash(body)
  return csp(match ? createHash("sha256").update(match[2]).digest("base64") : "")
}

function requestBody(request: HttpServerRequest.HttpServerRequest) {
  if (request.method === "GET" || request.method === "HEAD") return HttpBody.empty
  const len = request.headers["content-length"]
  return HttpBody.stream(request.stream, request.headers["content-type"], len === undefined ? undefined : Number(len))
}

function proxyResponseHeaders(headers: Record<string, string>) {
  const result = new Headers(headers)
  // FetchHttpClient exposes decoded response bodies, so forwarding upstream
  // transfer metadata makes browsers decode already-decoded assets again.
  result.delete("content-encoding")
  result.delete("content-length")
  result.delete("transfer-encoding")
  return result
}

export function upstreamURL(path: string) {
  if (!UI_UPSTREAM) throw new Error("No web UI upstream configured (set EXA_WEB_UI_UPSTREAM).")
  return new URL(path, UI_UPSTREAM).toString()
}

export function embeddedUI(disableEmbeddedWebUi: boolean) {
  if (disableEmbeddedWebUi) return Promise.resolve(null)
  return (embeddedUIPromise ??=
    // @ts-expect-error - generated file at build time
    import("exa-web-ui.gen.ts").then((module) => module.default as Record<string, string>).catch(() => null))
}

let embeddedDocsPromise: Promise<Record<string, string> | null> | undefined

/** The documentation site (packages/web, built statically), embedded at build
 *  time the same way the Studio UI is. Absent in dev builds. */
export function embeddedDocs() {
  return (embeddedDocsPromise ??=
    // @ts-expect-error - generated file at build time
    import("exa-docs.gen.ts").then((module) => module.default as Record<string, string>).catch(() => null))
}

function notFound() {
  return HttpServerResponse.jsonUnsafe({ error: "Not Found" }, { status: 404 })
}

function embeddedUIResponse(file: string, body: Uint8Array, status = 200) {
  const mime = FSUtil.mimeType(file)
  const headers = new Headers({ "content-type": mime })
  if (mime.startsWith("text/html")) {
    headers.set("content-security-policy", cspForHtml(new TextDecoder().decode(body)))
  }
  return HttpServerResponse.raw(body, { headers, status })
}

export function serveEmbeddedUIEffect(
  requestPath: string,
  fs: FSUtil.Interface,
  embeddedWebUI: Record<string, string>,
) {
  const file = embeddedWebUI[requestPath.replace(/^\//, "")] ?? embeddedWebUI["index.html"] ?? null
  if (!file) return Effect.succeed(notFound())

  return fs.readFile(file).pipe(
    Effect.map((body) => embeddedUIResponse(file, body)),
    Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(notFound())),
  )
}

/**
 * Serve one docs page. Unlike the Studio UI this is a multi-page site, so an
 * unknown path gets the site's own 404 page rather than index.html — falling
 * back to the homepage would make every typo silently show the intro.
 */
export function resolveDocsFile(requestPath: string, docs: Record<string, string>) {
  const key = decodeURIComponent(requestPath).replace(/^\/docs\/?/, "").replace(/\/$/, "")
  const resolved = docs[key] ?? docs[key === "" ? "index.html" : `${key}/index.html`]
  if (resolved) return { file: resolved, status: 200 }
  const fallback = docs["404.html"]
  return fallback ? { file: fallback, status: 404 } : undefined
}

export function serveDocsEffect(requestPath: string, fs: FSUtil.Interface, docs: Record<string, string>) {
  const resolved = resolveDocsFile(requestPath, docs)
  if (!resolved) return Effect.succeed(notFound())
  return fs.readFile(resolved.file).pipe(
    Effect.map((body) => embeddedUIResponse(resolved.file, body, resolved.status)),
    Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(notFound())),
  )
}

export function serveUIEffect(
  request: HttpServerRequest.HttpServerRequest,
  services: { fs: FSUtil.Interface; client: HttpClient.HttpClient; disableEmbeddedWebUi: boolean },
) {
  return Effect.gen(function* () {
    const embeddedWebUI = yield* Effect.promise(() => embeddedUI(services.disableEmbeddedWebUi))
    const path = new URL(request.url, "http://localhost").pathname

    if (embeddedWebUI) return yield* serveEmbeddedUIEffect(path, services.fs, embeddedWebUI)

    // No embedded bundle and no configured upstream: say so instead of
    // reaching out to a host the operator never chose.
    if (!UI_UPSTREAM)
      return HttpServerResponse.text("Web UI is not available in this build.", { status: 404 })

    const response = yield* services.client.execute(
      HttpClientRequest.make(request.method)(upstreamURL(path), {
        headers: ProxyUtil.headers(request.headers, { host: UI_UPSTREAM!.host }),
        body: requestBody(request),
      }),
    )
    const headers = proxyResponseHeaders(response.headers)

    if (response.headers["content-type"]?.includes("text/html")) {
      const body = yield* response.text
      headers.set("Content-Security-Policy", cspForHtml(body))
      return HttpServerResponse.text(body, { status: response.status, headers })
    }

    headers.set("Content-Security-Policy", csp())
    return HttpServerResponse.stream(response.stream.pipe(Stream.catchCause(() => Stream.empty)), {
      status: response.status,
      headers,
    })
  })
}
