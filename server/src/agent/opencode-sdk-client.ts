import {
  createOpencodeClient,
  type AssistantMessage,
  type GlobalEvent,
  type OpencodeClient,
  type Part,
  type Session,
} from '@opencode-ai/sdk'

import {
  getDisabledOpenCodeTools,
  getOpenCodeAgentName,
  getOpenCodeModelSelection,
  getOpenCodeSystemPrompt,
} from '../config'
import type { SessionContainerManager } from '../container/session-container'
import type { AgentRunTurnInput, AgentRunTurnResult, AgentRuntime } from './agent-runtime'

const opencodeRequestOptions = {
  responseStyle: 'data' as const,
  throwOnError: true as const,
}

const opencodeSessionErrorTimeoutMs = 5_000

/** Represents one OpenCode client state keyed by the active container URL. */
interface OpenCodeClientState {
  client: OpencodeClient
  sessionIdsByVideSessionId: Map<string, string>
}

/** Represents one cancellable wait for a matching OpenCode session error. */
interface SessionErrorWaiter {
  cancel: () => void
  result: Promise<string | null>
}

/** Returns one backend-safe message for OpenCode client failures. */
function toOpenCodeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'The OpenCode client request failed.'
}

/** Returns one readable message from one OpenCode error payload. */
function getOpenCodeErrorText(error: AssistantMessage['error'] | undefined): string | null {
  if (!error) {
    return null
  }

  const { data } = error

  if ('message' in data && typeof data.message === 'string' && data.message.trim().length > 0) {
    return data.message
  }

  return `OpenCode returned ${error.name}.`
}

/** Returns the final assistant text from one completed OpenCode message payload. */
function getAssistantText(parts: Part[], info: AssistantMessage): string {
  const errorText = getOpenCodeErrorText(info.error)

  if (errorText) {
    throw new Error(errorText)
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

/** Returns whether one unknown error was caused by aborting the fallback wait. */
function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

/** Returns one inert session-error waiter when the fallback stream is unavailable. */
function createNoopSessionErrorWaiter(): SessionErrorWaiter {
  return {
    cancel: () => undefined,
    result: Promise.resolve(null),
  }
}

/** Returns whether one streamed event is the matching OpenCode session.error payload. */
function getSessionErrorMessage(event: GlobalEvent, sessionId: string): string | null {
  if (event.payload.type !== 'session.error' || event.payload.properties.sessionID !== sessionId) {
    return null
  }

  return getOpenCodeErrorText(event.payload.properties.error) ?? 'OpenCode reported a session error.'
}

/** Returns whether one unknown prompt response matches the expected assistant payload shape. */
function isPromptResponse(
  value: unknown,
): value is {
  info: AssistantMessage
  parts: Part[]
} {
  if (typeof value !== 'object' || value === null) {
    return false
  }

  const candidate = value as {
    info?: unknown
    parts?: unknown
  }

  if (!Array.isArray(candidate.parts) || typeof candidate.info !== 'object' || candidate.info === null) {
    return false
  }

  return (candidate.info as { role?: unknown }).role === 'assistant'
}

/** Throws one fallback error message after waiting briefly for a matching OpenCode session error. */
async function throwPromptResponseError(
  sessionErrorWaiter: SessionErrorWaiter,
  fallbackMessage: string,
): Promise<never> {
  const sessionErrorMessage = await sessionErrorWaiter.result

  throw new Error(sessionErrorMessage ?? fallbackMessage)
}

/** Returns one assistant reply or falls back to the streamed OpenCode session error. */
async function getPromptAssistantText(
  response: unknown,
  sessionErrorWaiter: SessionErrorWaiter,
): Promise<string> {
  if (!isPromptResponse(response)) {
    return await throwPromptResponseError(
      sessionErrorWaiter,
      'OpenCode returned a malformed prompt response.',
    )
  }

  try {
    return getAssistantText(response.parts, response.info)
  } catch (error) {
    const sessionErrorMessage = await sessionErrorWaiter.result

    if (sessionErrorMessage) {
      throw new Error(sessionErrorMessage)
    }

    throw error
  }
}

/** Starts one short-lived waiter for a streamed OpenCode session.error event. */
async function createSessionErrorWaiter(
  client: OpencodeClient,
  sessionId: string,
): Promise<SessionErrorWaiter> {
  const controller = new AbortController()
  let timeoutId: ReturnType<typeof setTimeout> | null = setTimeout(() => {
    controller.abort()
  }, opencodeSessionErrorTimeoutMs)
  const clearTimeoutIfNeeded = () => {
    if (timeoutId !== null) {
      clearTimeout(timeoutId)
      timeoutId = null
    }
  }

  try {
    const events = await client.global.event({
      signal: controller.signal,
    })

    return {
      cancel: () => {
        clearTimeoutIfNeeded()
        controller.abort()
      },
      result: (async () => {
        try {
          for await (const event of events.stream) {
            const sessionErrorMessage = getSessionErrorMessage(event, sessionId)

            if (sessionErrorMessage) {
              return sessionErrorMessage
            }
          }
        } catch (error) {
          if (!isAbortError(error)) {
            return null
          }
        } finally {
          clearTimeoutIfNeeded()
        }

        return null
      })(),
    }
  } catch {
    clearTimeoutIfNeeded()
    return createNoopSessionErrorWaiter()
  }
}

/** Returns the current container base URL or throws when the session container is unavailable. */
function getReadyContainerBaseUrl(sessionContainerManager: SessionContainerManager): string {
  const snapshot = sessionContainerManager.getSnapshot()

  if (snapshot.status !== 'ready' || !snapshot.baseUrl) {
    throw new Error(snapshot.error || 'The session container is not ready yet.')
  }

  return snapshot.baseUrl
}

/** Returns one cached OpenCode client state for the provided container base URL. */
function getOpenCodeClientState(
  clientStatesByBaseUrl: Map<string, OpenCodeClientState>,
  baseUrl: string,
): OpenCodeClientState {
  const existingState = clientStatesByBaseUrl.get(baseUrl)

  if (existingState) {
    return existingState
  }

  const nextState: OpenCodeClientState = {
    client: createOpencodeClient({ baseUrl }),
    sessionIdsByVideSessionId: new Map(),
  }

  clientStatesByBaseUrl.set(baseUrl, nextState)
  return nextState
}

/** Creates one new OpenCode session for the provided VIde session identifier. */
async function createOpenCodeSession(
  state: OpenCodeClientState,
  videSessionId: string,
): Promise<Session> {
  const session = await state.client.session.create({
    ...opencodeRequestOptions,
    body: {
      title: `VIde ${videSessionId}`,
    },
  })

  state.sessionIdsByVideSessionId.set(videSessionId, session.id)
  return session
}

/** Ensures one OpenCode session exists for the provided VIde session identifier. */
async function ensureOpenCodeSession(
  state: OpenCodeClientState,
  videSessionId: string,
): Promise<Session> {
  const existingOpenCodeSessionId = state.sessionIdsByVideSessionId.get(videSessionId)

  if (!existingOpenCodeSessionId) {
    return await createOpenCodeSession(state, videSessionId)
  }

  try {
    return await state.client.session.get({
      ...opencodeRequestOptions,
      path: {
        id: existingOpenCodeSessionId,
      },
    })
  } catch {
    state.sessionIdsByVideSessionId.delete(videSessionId)
    return await createOpenCodeSession(state, videSessionId)
  }
}

/** Creates one thin OpenCode SDK client adapter for the active Docker container. */
export function createOpenCodeSdkClientAdapter(
  sessionContainerManager: SessionContainerManager,
): AgentRuntime {
  const clientStatesByBaseUrl = new Map<string, OpenCodeClientState>()

  return {
    async runTurn(input: AgentRunTurnInput): Promise<AgentRunTurnResult> {
      try {
        const baseUrl = getReadyContainerBaseUrl(sessionContainerManager)
        const state = getOpenCodeClientState(clientStatesByBaseUrl, baseUrl)
        const session = await ensureOpenCodeSession(state, input.sessionId)
        const { providerID, modelID } = getOpenCodeModelSelection()
        const sessionErrorWaiter = await createSessionErrorWaiter(state.client, session.id)

        try {
          const response = await state.client.session.prompt({
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
          })

          return {
            assistantText: await getPromptAssistantText(response, sessionErrorWaiter),
          }
        } finally {
          sessionErrorWaiter.cancel()
        }
      } catch (error) {
        throw new Error(toOpenCodeErrorMessage(error))
      }
    },
    async destroy(): Promise<void> {
      clientStatesByBaseUrl.clear()
    },
  }
}
