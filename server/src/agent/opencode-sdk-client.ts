import {
  createOpencodeClient,
  type AssistantMessage,
  type OpencodeClient,
  type Part,
  type Session,
} from '@opencode-ai/sdk'

import {
  createOpenCodeRuntimeOptions,
  getOpenCodeModelSelection,
  type OpenCodeRuntimeOptions,
} from '../config'
import type { SessionRuntimeManager } from '../container/session-container'
import type { WorkspaceSessionRuntimeManager } from '../container/workspace-session-container'
import type { AgentRunTurnInput, AgentRunTurnResult, AgentRuntime } from './agent-runtime'
import { createOpenCodePromptMonitor, type OpenCodePromptMonitor } from './opencode-prompt-monitor'

const opencodeRequestOptions = {
  responseStyle: 'data' as const,
  throwOnError: true as const,
}

const opencodeSessionErrorTimeoutMs = 5_000

/** Represents one OpenCode client state keyed by the active runtime URL. */
interface OpenCodeClientState {
  client: OpencodeClient
  sessionIdsByVideSessionId: Map<string, string>
}

/** Returns one backend-safe message for OpenCode client failures. */
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

  return 'The OpenCode client request failed.'
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
  promptMonitor: OpenCodePromptMonitor,
  fallbackMessage: string,
): Promise<never> {
  const sessionErrorMessage = await promptMonitor.waitForSessionError(opencodeSessionErrorTimeoutMs)

  throw new Error(sessionErrorMessage ?? fallbackMessage)
}

/** Returns one assistant reply or falls back to the streamed OpenCode session error. */
async function getPromptAssistantText(
  response: unknown,
  promptMonitor: OpenCodePromptMonitor,
): Promise<string> {
  if (!isPromptResponse(response)) {
    return await throwPromptResponseError(
      promptMonitor,
      'OpenCode returned a malformed prompt response.',
    )
  }

  try {
    return getAssistantText(response.parts, response.info)
  } catch (error) {
    const sessionErrorMessage = await promptMonitor.waitForSessionError(opencodeSessionErrorTimeoutMs)

    if (sessionErrorMessage) {
      throw new Error(sessionErrorMessage)
    }

    throw error
  }
}

/** Returns whether the provided runtime manager exposes one attached workspace directory. */
function isWorkspaceSessionRuntimeManager(
  sessionRuntimeManager: SessionRuntimeManager,
): sessionRuntimeManager is WorkspaceSessionRuntimeManager {
  return 'attachWorkspace' in sessionRuntimeManager
}

/** Returns one unsafe-host workspace directory to thread into OpenCode requests when needed. */
function getUnsafeHostWorkspaceDirectory(
  sessionRuntimeManager: SessionRuntimeManager,
): string | undefined {
  const snapshot = sessionRuntimeManager.getSnapshot()

  if (
    snapshot.executionMode !== 'unsafe-host' ||
    !isWorkspaceSessionRuntimeManager(sessionRuntimeManager)
  ) {
    return undefined
  }

  return sessionRuntimeManager.getWorkspaceDirectory() ?? undefined
}

/** Returns the current runtime base URL or throws when the session runtime is unavailable. */
function getReadyRuntimeBaseUrl(sessionRuntimeManager: SessionRuntimeManager): string {
  const snapshot = sessionRuntimeManager.getSnapshot()

  if (snapshot.status !== 'ready' || !snapshot.baseUrl) {
    throw new Error(snapshot.error || 'The session runtime is not ready yet.')
  }

  return snapshot.baseUrl
}

/** Returns one stable cache key for the provided runtime base URL and workspace directory. */
function getRuntimeClientStateKey(baseUrl: string, workspaceDirectory?: string): string {
  return workspaceDirectory ? `${baseUrl}::${workspaceDirectory}` : baseUrl
}

/** Returns one cached OpenCode client state for the provided runtime key. */
function getOpenCodeClientState(
  clientStatesByRuntimeKey: Map<string, OpenCodeClientState>,
  runtimeKey: string,
  baseUrl: string,
): OpenCodeClientState {
  const existingState = clientStatesByRuntimeKey.get(runtimeKey)

  if (existingState) {
    return existingState
  }

  const nextState: OpenCodeClientState = {
    client: createOpencodeClient({ baseUrl }),
    sessionIdsByVideSessionId: new Map(),
  }

  clientStatesByRuntimeKey.set(runtimeKey, nextState)
  return nextState
}

/** Creates one new OpenCode session for the provided VIde session identifier. */
async function createOpenCodeSession(
  state: OpenCodeClientState,
  videSessionId: string,
  workspaceDirectory?: string,
): Promise<Session> {
  const session = await state.client.session.create({
    ...opencodeRequestOptions,
    body: {
      title: `VIde ${videSessionId}`,
    },
    ...(workspaceDirectory
      ? {
          query: {
            directory: workspaceDirectory,
          },
        }
      : {}),
  })

  state.sessionIdsByVideSessionId.set(videSessionId, session.id)
  return session
}

/** Ensures one OpenCode session exists for the provided VIde session identifier. */
async function ensureOpenCodeSession(
  state: OpenCodeClientState,
  videSessionId: string,
  workspaceDirectory?: string,
): Promise<Session> {
  const existingOpenCodeSessionId = state.sessionIdsByVideSessionId.get(videSessionId)

  if (!existingOpenCodeSessionId) {
    return await createOpenCodeSession(state, videSessionId, workspaceDirectory)
  }

  try {
    return await state.client.session.get({
      ...opencodeRequestOptions,
      path: {
        id: existingOpenCodeSessionId,
      },
      ...(workspaceDirectory
        ? {
            query: {
              directory: workspaceDirectory,
            },
          }
        : {}),
    })
  } catch {
    state.sessionIdsByVideSessionId.delete(videSessionId)
    return await createOpenCodeSession(state, videSessionId, workspaceDirectory)
  }
}

/** Creates one thin OpenCode SDK client adapter for the active runtime manager. */
export function createOpenCodeSdkClientAdapter(
  sessionRuntimeManager: SessionRuntimeManager,
  openCodeOptionsInput: Partial<OpenCodeRuntimeOptions> = {},
): AgentRuntime {
  const openCodeOptions = createOpenCodeRuntimeOptions(openCodeOptionsInput)
  const clientStatesByRuntimeKey = new Map<string, OpenCodeClientState>()

  return {
    async runTurn(input: AgentRunTurnInput): Promise<AgentRunTurnResult> {
      try {
        const baseUrl = getReadyRuntimeBaseUrl(sessionRuntimeManager)
        const workspaceDirectory = getUnsafeHostWorkspaceDirectory(sessionRuntimeManager)
        const runtimeKey = getRuntimeClientStateKey(baseUrl, workspaceDirectory)
        const state = getOpenCodeClientState(clientStatesByRuntimeKey, runtimeKey, baseUrl)
        const session = await ensureOpenCodeSession(state, input.sessionId, workspaceDirectory)
        const promptStartedAtMs = Date.now()
        const promptMonitor = await createOpenCodePromptMonitor(
          state.client,
          session.id,
          promptStartedAtMs,
          input.onAssistantTextUpdate,
        )

        try {
          let response: unknown

          try {
            const { providerID, modelID } = getOpenCodeModelSelection(openCodeOptions.model)
            response = await state.client.session.prompt({
              ...opencodeRequestOptions,
              body: {
                agent: openCodeOptions.agentName,
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
                system: openCodeOptions.systemPrompt,
              },
              path: {
                id: session.id,
              },
              ...(workspaceDirectory
                ? {
                    query: {
                      directory: workspaceDirectory,
                    },
                  }
                : {}),
            })
          } catch (error) {
            const sessionErrorMessage =
              await promptMonitor.waitForSessionError(opencodeSessionErrorTimeoutMs)

            throw new Error(sessionErrorMessage ?? toOpenCodeErrorMessage(error))
          }

          return {
            assistantText: await getPromptAssistantText(response, promptMonitor),
          }
        } finally {
          promptMonitor.cancel()
        }
      } catch (error) {
        throw new Error(toOpenCodeErrorMessage(error))
      }
    },
    async destroy(): Promise<void> {
      clientStatesByRuntimeKey.clear()
    },
  }
}
