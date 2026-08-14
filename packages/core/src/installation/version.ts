declare global {
  const EXA_VERSION: string
  const EXA_CHANNEL: string
}

export const InstallationVersion = typeof EXA_VERSION === "string" ? EXA_VERSION : "local"
export const InstallationChannel = typeof EXA_CHANNEL === "string" ? EXA_CHANNEL : "local"
export const InstallationLocal = InstallationChannel === "local"
