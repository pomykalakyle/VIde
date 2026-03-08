import {
  createOpencode,
  type AssistantMessage,
  type OpencodeClient,
  type Part,
  type Session,
} from '@opencode-ai/sdk'

import {
  getDisabledOpenCodeTools,
  getOpenCodeAgentName,
  getOpenCodeConfig,
  getOpenCodeModelSelection,
  getOpenCodeSystemPrompt,
  getWorkspaceDirectory,
} from '../config'
import type { AgentRunTurnInput, AgentRunTurnResult, AgentRuntime } from './agent-runtime'

const opencodeRequestOptions = {
  responseStyle: 'data' as const,
  throwOnError: true as const,
}

/** Represents one embedded OpenCode instance managed by the Bun backend. */
interface EmbeddedOpenCodeInstance {
  client: OpencodeClient
  server: {
    close(): void
  }
  sessionIdsByVideSessionId: Map<string, string>
}

/** Returns one backend-safe message for OpenCode runtime failures. */
function toOpenCodeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'The OpenCode runtime failed.'
}

/** Returns the final assistant text from one completed OpenCode message payload. */
function getAssistantText(parts: Part[], info: AssistantMessage): string {
  if (info.error) {
    throw new Error(info.error.data.message)
  }

  const assistantText = parts
    .flatMap((part) => (part.type === 'text' && !part.ignored ? [part.text] : []))
    .join('')
    .trim()

  if (assistantText) {
    return assistantText
  }

  throw new Error('OpenCode returned no assistant text.')
}

/** Creates one new embedded OpenCode instance for the Bun backend. */
async function createEmbeddedOpenCodeInstance(): Promise<EmbeddedOpenCodeInstance> {
  const { client, server } = await createOpencode({
    config: getOpenCodeConfig(),
  })

  return {
    client,
    server,
    sessionIdsByVideSessionId: new Map(),
  }
}

/** Ensures one OpenCode session exists for the given VIde session identifier. */
async function ensureOpenCodeSession(
  instance: EmbeddedOpenCodeInstance,
  videSessionId: string,
): Promise<Session> {
  const existingOpenCodeSessionId = instance.sessionIdsByVideSessionId.get(videSessionId)

  if (existingOpenCodeSessionId) {
    return await instance.client.session.get({
      ...opencodeRequestOptions,
      path: {
        id: existingOpenCodeSessionId,
      },
      query: {
        directory: getWorkspaceDirectory(),
      },
    })
  }

  const session = await instance.client.session.create({
    ...opencodeRequestOptions,
    body: {
      title: `VIde ${videSessionId}`,
    },
    query: {
      directory: getWorkspaceDirectory(),
    },
  })

  instance.sessionIdsByVideSessionId.set(videSessionId, session.id)
  return session
}

/** Creates one runtime that delegates assistant turns to an embedded OpenCode instance. */
export function createOpenCodeAgentRuntime(): AgentRuntime {
  let instancePromise: Promise<EmbeddedOpenCodeInstance> | null = null

  async function getInstance(): Promise<EmbeddedOpenCodeInstance> {
    if (!instancePromise) {
      instancePromise = createEmbeddedOpenCodeInstance()
    }

    return await instancePromise
  }

  return {
    async runTurn(input: AgentRunTurnInput): Promise<AgentRunTurnResult> {
      try {
        const instance = await getInstance()
        const session = await ensureOpenCodeSession(instance, input.sessionId)
        const { providerID, modelID } = getOpenCodeModelSelection()
        const response = await instance.client.session.prompt({
          ...opencodeRequestOptions,
          body: {
            agent: getOpenCodeAgentName(),
            model: {
              modelID,
              providerID,
            },
            parts: [
              {
                text: input.userText,
                type: 'text',
              },
            ],
            system: getOpenCodeSystemPrompt(),
            tools: getDisabledOpenCodeTools(),
          },
          path: {
            id: session.id,
          },
          query: {
            directory: getWorkspaceDirectory(),
          },
        })

        return {
          assistantText: getAssistantText(response.parts, response.info),
        }
      } catch (error) {
        throw new Error(toOpenCodeErrorMessage(error))
      }
    },
    async destroy(): Promise<void> {
      if (!instancePromise) {
        return
      }

      const instance = await instancePromise
      instance.server.close()
      instancePromise = null
    },
  }
}
