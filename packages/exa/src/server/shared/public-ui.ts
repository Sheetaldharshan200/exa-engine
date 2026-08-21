// Static UI assets the browser fetches without app-managed credentials, e.g.
// the manifest link in <head>. These bypass auth so the page can install/render
// the manifest icons even when a server password is configured.
export const PUBLIC_UI_PATHS = new Set<string>([
  "/site.webmanifest",
  "/web-app-manifest-192x192.png",
  "/web-app-manifest-512x512.png",
])

export function isPublicUIPath(method: string, pathname: string) {
  return method === "GET" && PUBLIC_UI_PATHS.has(pathname)
}

/** The vault's own ceremony — must be reachable BEFORE any session exists. */
const VAULT_IPC = new Set(["/ipc/vault_status", "/ipc/vault_setup", "/ipc/vault_unlock", "/ipc/vault_recover"])

/**
 * In vault mode the app shell is public and the app's unlock screen is the
 * door: the HTML, its static bundle, and the vault IPC commands answer without
 * credentials, everything else needs the session the unlock issues (or basic
 * auth, for CLI clients). The shell itself contains no data.
 */
export function isVaultPublicPath(method: string, pathname: string) {
  if (isPublicUIPath(method, pathname)) return true
  if (method === "POST") return VAULT_IPC.has(pathname)
  if (method !== "GET") return false
  return (
    pathname === "/" ||
    pathname === "/index.html" ||
    pathname === "/favicon.svg" ||
    pathname === "/favicon.ico" ||
    pathname.startsWith("/assets/")
  )
}
