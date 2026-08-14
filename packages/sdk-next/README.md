# @exa/sdk-next

Effect-native scoped Exa host for in-process applications. This transitional package will replace the existing generated `@exa/sdk` after its consumers migrate.

The SDK executes Server's assembled HTTP router in memory. It opens no listener and performs no network I/O, while preserving the same routing, middleware, handlers, codecs, and errors as the network client.

```ts
import { Exa } from "@exa/sdk-next"

const exa = yield * Exa.create()
const session = yield * exa.sessions.get({ sessionID })
```

It also exports `Tool` and exposes local-only `tools.register(...)`, replacing the former `@exa/core/public` facade. Registration uses Core's host-level `ApplicationTools` service shared by the host's Locations; each Location retains its own `ToolRegistry` for overlay, lookup, and settlement. Closing the owning Effect Scope releases router resources, location services, fibers, and scoped tool registrations.

`sessions.events({ sessionID, after })` replays durable events after the optional aggregate sequence, then emits newly committed durable events. `sessions.interrupt(...)` targets execution owned by this host, and `sessions.message(...)` retrieves one projected Session message.

The same constructor is available as a service Layer:

```ts
const program = Effect.gen(function* () {
  const exa = yield* Exa.Service
  return yield* exa.sessions.get({ sessionID })
})

yield * program.pipe(Effect.provide(Exa.layer))
```

`Exa.layer` adapts `Exa.create()` for dependency injection; it does not define another host implementation.
