import {
  createOpencode,
  type AssistantMessage,
  type OpencodeClient,
  type Part,
  type Session,
} from '@opencode-ai/sdk'

import {
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

/** Represents one embedded OpenCode instance reserved for local debugging paths. */
interface EmbeddedOpenCodeInstance {
  client: OpencodeClient
  server: {
    close(): void
  }
  sessionIdsByVideSessionId: Map<string, string>
}

/** Returns one backend-safe message for OpenCode runtime failures. */
function toOpenCodeErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }

  if (typeof error === 'object' && error !== null) {
    const candidate = error as {
      data?: unknown
      message?: unknown
    }

    if (typeof candidate.message === 'string' && candidate.message.trim().length > 0) {
      return candidate.message
    }

    if (typeof candidate.data === 'object' && candidate.data !== null) {
      const data = candidate.data as { message?: unknown }

      if (typeof data.message === 'string' && data.message.trim().length > 0) {
        return data.message
      }
    }
  }

  return 'The OpenCode runtime failed.'
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

/** Creates one embedded OpenCode runtime reserved for non-production debugging. */
export function createEmbeddedOpenCodeAgentRuntime(): AgentRuntime {
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
          },
          path: {
            id: session.id,
          },
          query: {
            directory: getWorkspaceDirectory(),
          },
        })
        const assistantText = getAssistantText(response.parts, response.info)

        await input.onAssistantTextUpdate?.(assistantText)

        return {
          assistantText,
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
