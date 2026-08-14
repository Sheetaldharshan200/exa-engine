interface ImportMetaEnv {
  readonly EXA_CHANNEL: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

declare module "virtual:exa-server" {
  export namespace Server {
    export const listen: typeof import("../../../exa/dist/types/src/node").Server.listen
    export type Listener = import("../../../exa/dist/types/src/node").Server.Listener
  }
  export namespace Config {
    export const get: typeof import("../../../exa/dist/types/src/node").Config.get
    export type Info = import("../../../exa/dist/types/src/node").Config.Info
  }
  export const bootstrap: typeof import("../../../exa/dist/types/src/node").bootstrap
}
