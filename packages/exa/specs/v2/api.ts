// @ts-nocheck

import { Exa } from "@exa/core"
import { ReadTool } from "@exa/core/tools"

const exa = Exa.make({})

exa.tool.add(ReadTool)

exa.tool.add({
  name: "bash",
  schema: {
    type: "object",
    properties: {
      command: {
        type: "string",
        description: "The command to run.",
      },
    },
    required: ["command"],
  },
  execute(input, ctx) {},
})

exa.auth.add({
  provider: "openai",
  type: "api",
  value: process.env.OPENAI_API_KEY,
})

exa.agent.add({
  name: "build",
  permissions: [],
  model: {
    id: "gpt-5-5",
    provider: "openai",
    variant: "xhigh",
  },
})

const sessionID = await exa.session.create({
  agent: "build",
})

exa.subscribe((event) => {
  console.log(event)
})

await exa.session.prompt({
  sessionID,
  text: "hey what is up",
})

await exa.session.prompt({
  sessionID,
  text: "what is up with this",
  files: [
    {
      mime: "image/png",
      uri: "data:image/png;base64,xxxx",
    },
  ],
})

await exa.session.wait()

console.log(await exa.session.messages(sessionID))
