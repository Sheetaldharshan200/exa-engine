import type { Hooks, PluginInput } from "@exa/plugin"
import type { Model } from "@exa/sdk/v2"
import { InstallationVersion } from "@exa/core/installation/version"
import { iife } from "@/util/iife"
import { setTimeout as sleep } from "node:timers/promises"
import { CopilotModels } from "./models"
import { MessageV2 } from "@/session/message-v2"

/**
 * The GitHub OAuth app used for Copilot's device login.
 *
 * A client id identifies whoever registered the app, and GitHub shows that
 * owner's name on the consent screen — which is why the upstream project's id
 * could not stay: it asked every user to authorize a company unrelated to this
 * product. This is Exa's own app, so the consent screen names Exa.
 *
 * The id is not a secret. GitHub's device flow sends it in the clear from every
 * client and has no client secret at all, so it ships in the source the same way
 * other CLIs ship theirs. The secret in this flow is the token GitHub returns,
 * which never leaves the user's machine.
 *
 * Override it with EXA_COPILOT_CLIENT_ID, or provider["github-copilot"]
 * .options.clientId in exa.json, to point the login at your own app instead.
 */
const DEFAULT_CLIENT_ID = "Ov23liz4QdgwzRWpLGFZ"

const CLIENT_ID_HELP =
  "GitHub Copilot login needs an OAuth app you control. Create one at " +
  "https://github.com/settings/developers (enable device flow), then set " +
  "EXA_COPILOT_CLIENT_ID=<client id> — or add it to exa.json under " +
  'provider."github-copilot".options.clientId.'

/** GitHub's device-flow error codes, in terms of what to do about them. */
function deviceFlowError(code: string, description?: string): string {
  const detail = description ? ` (${description})` : ""
  switch (code) {
    case "access_denied":
      return "Authorization was declined on GitHub. Run the login again and approve the app."
    case "expired_token":
      return "The device code expired before it was entered. Run the login again and enter the code promptly."
    case "device_flow_disabled":
      return (
        "This GitHub app does not have device flow enabled. Turn it on in the app's settings " +
        "(GitHub → Settings → Developer settings → OAuth Apps → your app → Enable Device Flow)."
      )
    case "incorrect_client_credentials":
      return `The client id is not accepted by GitHub${detail}. Check EXA_COPILOT_CLIENT_ID, or the id in exa.json.`
    case "unsupported_grant_type":
      return `GitHub rejected the device-flow grant${detail}.`
    default:
      return `GitHub returned "${code}"${detail}.`
  }
}

async function clientId(): Promise<string | undefined> {
  const fromEnv = process.env["EXA_COPILOT_CLIENT_ID"]?.trim()
  if (fromEnv) return fromEnv
  const { Global } = await import("@exa/core/global")
  const fs = await import("node:fs/promises")
  const path = await import("node:path")
  for (const name of ["exa.json", "exa.jsonc"]) {
    try {
      const text = await fs.readFile(path.join(Global.Path.config, name), "utf8")
      const parsed = JSON.parse(text.replace(/^\s*\/\/.*$/gm, "")) as {
        provider?: Record<string, { options?: { clientId?: unknown } }>
      }
      const id = parsed.provider?.["github-copilot"]?.options?.clientId
      if (typeof id === "string" && id.trim()) return id.trim()
    } catch {
      /* absent or unparseable — fall through to the default */
    }
  }
  return DEFAULT_CLIENT_ID
}
const API_VERSION = "2026-06-01"
const UTILITY_MODELS = ["gpt-5.4-nano", "gpt-4.1", "gpt-4o", "gpt-4o-mini"]
// Add a small safety buffer when polling to avoid hitting the server
// slightly too early due to clock skew / timer drift.
const OAUTH_POLLING_SAFETY_MARGIN_MS = 3000 // 3 seconds
function normalizeDomain(url: string) {
  return url.replace(/^https?:\/\//, "").replace(/\/$/, "")
}

function getUrls(domain: string) {
  return {
    DEVICE_CODE_URL: `https://${domain}/login/device/code`,
    ACCESS_TOKEN_URL: `https://${domain}/login/oauth/access_token`,
  }
}

function base(enterpriseUrl?: string) {
  return enterpriseUrl ? `https://copilot-api.${normalizeDomain(enterpriseUrl)}` : "https://api.githubcopilot.com"
}

// Check if a message is a synthetic user msg used to attach an image from a tool call
function imgMsg(msg: any): boolean {
  if (msg?.role !== "user") return false

  // Handle the 3 api formats

  const content = msg.content
  if (typeof content === "string") return content === MessageV2.SYNTHETIC_ATTACHMENT_PROMPT
  if (!Array.isArray(content)) return false
  return content.some(
    (part: any) =>
      (part?.type === "text" || part?.type === "input_text") && part.text === MessageV2.SYNTHETIC_ATTACHMENT_PROMPT,
  )
}

function fix(model: Model, url: string): Model {
  return {
    ...model,
    api: {
      ...model.api,
      url,
      npm: "@ai-sdk/github-copilot",
    },
  }
}

export async function CopilotAuthPlugin(input: PluginInput): Promise<Hooks> {
  const sdk = input.client
  let models: Record<string, Model> = {}
  return {
    provider: {
      id: "github-copilot",
      async models(provider, ctx) {
        if (ctx.auth?.type !== "oauth") {
          models = {}
          return Object.fromEntries(Object.entries(provider.models).map(([id, model]) => [id, fix(model, base())]))
        }

        const auth = ctx.auth

        return CopilotModels.get(
          base(auth.enterpriseUrl),
          {
            ...(provider.options?.headers as Record<string, string> | undefined),
            Authorization: `Bearer ${auth.refresh}`,
            "User-Agent": `exa/${InstallationVersion}`,
            "X-GitHub-Api-Version": API_VERSION,
          },
          provider.models,
        )
          .then((result) => {
            models = result.models
            return Object.fromEntries(
              Object.entries(result.models).filter(([, model]) => result.pickerEnabled.has(model.api.id)),
            )
          })
          .catch((error) => {
            // Say what happened. Silently swapping in a different list made a
            // slow network look identical to a broken account, with nothing in
            // the output to tell them apart.
            const reason = error instanceof Error ? error.message : String(error)
            const timedOut = error instanceof Error && error.name === "TimeoutError"
            console.warn(
              `[github-copilot] could not read the model list from GitHub: ${
                timedOut ? "the request timed out" : reason
              }. Showing the last known models.`,
            )

            // Prefer what GitHub actually served this session. The catalogue is
            // a generic list of what Copilot offers SOMEWHERE — for an account
            // that cannot reach those models it is entirely wrong, and picking
            // one only fails later at request time. Fall back to it just when
            // there is nothing better.
            const known = Object.keys(models).length > 0 ? models : provider.models
            return Object.fromEntries(
              Object.entries(known).map(([id, model]) => [id, fix(model, base(auth.enterpriseUrl))]),
            )
          })
      },
    },
    auth: {
      provider: "github-copilot",
      async loader(getAuth) {
        const info = await getAuth()
        if (!info || info.type !== "oauth") return {}

        return {
          apiKey: "",
          async fetch(request: RequestInfo | URL, init?: RequestInit) {
            const info = await getAuth()
            if (info.type !== "oauth") return fetch(request, init)

            const url = request instanceof URL ? request.href : typeof request === "string" ? request : request.url
            const { isVision, isAgent } = iife(() => {
              try {
                const body = typeof init?.body === "string" ? JSON.parse(init.body) : init?.body

                // Completions API
                if (body?.messages && url.includes("completions")) {
                  const last = body.messages[body.messages.length - 1]
                  return {
                    isVision: body.messages.some(
                      (msg: any) =>
                        Array.isArray(msg.content) && msg.content.some((part: any) => part.type === "image_url"),
                    ),
                    isAgent: last?.role !== "user" || imgMsg(last),
                  }
                }

                // Responses API
                if (body?.input) {
                  const last = body.input[body.input.length - 1]
                  return {
                    isVision: body.input.some(
                      (item: any) =>
                        Array.isArray(item?.content) && item.content.some((part: any) => part.type === "input_image"),
                    ),
                    isAgent: last?.role !== "user" || imgMsg(last),
                  }
                }

                // Messages API
                if (body?.messages) {
                  const last = body.messages[body.messages.length - 1]
                  const hasNonToolCalls =
                    Array.isArray(last?.content) && last.content.some((part: any) => part?.type !== "tool_result")
                  return {
                    isVision: body.messages.some(
                      (item: any) =>
                        Array.isArray(item?.content) &&
                        item.content.some(
                          (part: any) =>
                            part?.type === "image" ||
                            // images can be nested inside tool_result content
                            (part?.type === "tool_result" &&
                              Array.isArray(part?.content) &&
                              part.content.some((nested: any) => nested?.type === "image")),
                        ),
                    ),
                    isAgent: !(last?.role === "user" && hasNonToolCalls) || imgMsg(last),
                  }
                }
              } catch {}
              return { isVision: false, isAgent: false }
            })

            const headers: Record<string, string> = {
              "x-initiator": isAgent ? "agent" : "user",
              ...(init?.headers as Record<string, string>),
              "User-Agent": `exa/${InstallationVersion}`,
              Authorization: `Bearer ${info.refresh}`,
              "Openai-Intent": "conversation-edits",
            }

            if (isVision) {
              headers["Copilot-Vision-Request"] = "true"
            }

            delete headers["x-api-key"]
            delete headers["authorization"]

            return fetch(request, {
              ...init,
              headers,
            })
          },
        }
      },
      methods: [
        {
          type: "oauth",
          label: "Login with GitHub Copilot",
          prompts: [
            {
              type: "select",
              key: "deploymentType",
              message: "Select GitHub deployment type",
              options: [
                {
                  label: "GitHub.com",
                  value: "github.com",
                  hint: "Public",
                },
                {
                  label: "GitHub Enterprise",
                  value: "enterprise",
                  hint: "Data residency or self-hosted",
                },
              ],
            },
            {
              type: "text",
              key: "enterpriseUrl",
              message: "Enter your GitHub Enterprise URL or domain",
              placeholder: "company.ghe.com or https://company.ghe.com",
              when: { key: "deploymentType", op: "eq", value: "enterprise" },
              validate: (value) => {
                if (!value) return "URL or domain is required"
                try {
                  const url = value.includes("://") ? new URL(value) : new URL(`https://${value}`)
                  if (!url.hostname) return "Please enter a valid URL or domain"
                  return undefined
                } catch {
                  return "Please enter a valid URL (e.g., company.ghe.com or https://company.ghe.com)"
                }
              },
            },
          ],
          async authorize(inputs = {}) {
            const deploymentType = inputs.deploymentType || "github.com"

            let domain = "github.com"

            if (deploymentType === "enterprise") {
              const enterpriseUrl = inputs.enterpriseUrl
              domain = normalizeDomain(enterpriseUrl!)
            }

            const urls = getUrls(domain)

            // No id, no login. Falling back to a shipped one would put someone
            // else's name on GitHub's consent screen.
            const id = await clientId()
            if (!id) throw new Error(CLIENT_ID_HELP)

            const deviceResponse = await fetch(urls.DEVICE_CODE_URL, {
              method: "POST",
              headers: {
                Accept: "application/json",
                "Content-Type": "application/json",
                "User-Agent": `exa/${InstallationVersion}`,
              },
              body: JSON.stringify({
                client_id: id,
                scope: "read:user",
              }),
            })

            if (!deviceResponse.ok) {
              throw new Error("Failed to initiate device authorization")
            }

            const deviceData = (await deviceResponse.json()) as {
              verification_uri: string
              user_code: string
              device_code: string
              interval: number
            }

            return {
              url: deviceData.verification_uri,
              instructions: `Enter code: ${deviceData.user_code}`,
              method: "auto" as const,
              async callback() {
                while (true) {
                  const response = await fetch(urls.ACCESS_TOKEN_URL, {
                    method: "POST",
                    headers: {
                      Accept: "application/json",
                      "Content-Type": "application/json",
                      "User-Agent": `exa/${InstallationVersion}`,
                    },
                    body: JSON.stringify({
                      client_id: id,
                      device_code: deviceData.device_code,
                      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
                    }),
                  })

                  if (!response.ok) {
                    throw new Error(
                      `GitHub rejected the token request (HTTP ${response.status}). ${await response.text().catch(() => "")}`.trim(),
                    )
                  }

                  const data = (await response.json()) as {
                    access_token?: string
                    error?: string
                    error_description?: string
                    interval?: number
                  }

                  if (data.access_token) {
                    const result: {
                      type: "success"
                      refresh: string
                      access: string
                      expires: number
                      provider?: string
                      enterpriseUrl?: string
                    } = {
                      type: "success",
                      refresh: data.access_token,
                      access: data.access_token,
                      expires: 0,
                    }

                    if (deploymentType === "enterprise") {
                      result.enterpriseUrl = domain
                    }

                    return result
                  }

                  if (data.error === "authorization_pending") {
                    await sleep(deviceData.interval * 1000 + OAUTH_POLLING_SAFETY_MARGIN_MS)
                    continue
                  }

                  if (data.error === "slow_down") {
                    // Based on the RFC spec, we must add 5 seconds to our current polling interval.
                    // (See https://www.rfc-editor.org/rfc/rfc8628#section-3.5)
                    let newInterval = (deviceData.interval + 5) * 1000

                    // GitHub OAuth API may return the new interval in seconds in the response.
                    // We should try to use that if provided with safety margin.
                    const serverInterval = data.interval
                    if (serverInterval && typeof serverInterval === "number" && serverInterval > 0) {
                      newInterval = serverInterval * 1000
                    }

                    await sleep(newInterval + OAUTH_POLLING_SAFETY_MARGIN_MS)
                    continue
                  }

                  // Everything else is terminal. Reporting a bare "failed"
                  // here made every cause look identical — a denied consent, an
                  // expired code and an app that cannot mint Copilot tokens all
                  // printed the same thing, so there was nothing to act on.
                  if (data.error) throw new Error(deviceFlowError(data.error, data.error_description))

                  await sleep(deviceData.interval * 1000 + OAUTH_POLLING_SAFETY_MARGIN_MS)
                  continue
                }
              },
            }
          },
        },
      ],
    },
    "chat.params": async (incoming, output) => {
      if (!incoming.model.providerID.includes("github-copilot")) return

      // Match github copilot cli, omit maxOutputTokens for gpt models
      if (incoming.model.api.id.includes("gpt")) {
        output.maxOutputTokens = undefined
      }

      // GitHub Copilot's /v1/messages shim rejects the GA `eager_input_streaming`
      // field on tool definitions ("Extra inputs are not permitted"). Opt out of
      // the @ai-sdk/anthropic default so it stops injecting the field.
      if (incoming.model.api.npm === "@ai-sdk/anthropic") {
        output.options.toolStreaming = false
      }
    },
    "experimental.provider.small_model": async (incoming, output) => {
      if (incoming.provider.id !== "github-copilot") return
      // GitHub exposes utility models for title generation without including them in the picker.
      output.model = UTILITY_MODELS.map((id) => models[id]).find((model) => model !== undefined)
    },
    "chat.headers": async (incoming, output) => {
      if (!incoming.model.providerID.includes("github-copilot")) return

      output.headers["X-GitHub-Api-Version"] = API_VERSION
      if (incoming.agent === "title") {
        output.headers["X-Interaction-Type"] = "agent-session-name-generation"
      }

      if (incoming.model.api.npm === "@ai-sdk/anthropic") {
        output.headers["anthropic-beta"] = "interleaved-thinking-2025-05-14"
      }

      const parts = await sdk.session
        .message({
          path: {
            id: incoming.message.sessionID,
            messageID: incoming.message.id,
          },
          query: {
            directory: input.directory,
          },
          throwOnError: true,
        })
        .catch(() => undefined)

      if (
        parts?.data.parts?.some(
          (part) =>
            part.type === "compaction" ||
            // Auto-compaction resumes via a synthetic user text part. Treat only
            // that marked followup as agent-initiated so manual prompts stay user-initiated.
            (part.type === "text" && part.synthetic && part.metadata?.compaction_continue === true),
        )
      ) {
        output.headers["x-initiator"] = "agent"
        return
      }

      const session = await sdk.session
        .get({
          path: {
            id: incoming.sessionID,
          },
          query: {
            directory: input.directory,
          },
          throwOnError: true,
        })
        .catch(() => undefined)
      if (!session || !session.data.parentID) return
      // mark subagent sessions as agent initiated matching standard that other copilot tools have
      output.headers["x-initiator"] = "agent"
    },
  }
}
