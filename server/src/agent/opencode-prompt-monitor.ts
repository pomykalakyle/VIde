import type { AssistantMessage, GlobalEvent, OpencodeClient } from '@opencode-ai/sdk'

import type { AgentAssistantTextUpdate } from './agent-runtime'

/** Represents one cancellable OpenCode prompt monitor backed by the global event stream. */
export interface OpenCodePromptMonitor {
  cancel: () => void
  waitForSessionError: (timeoutMs: number) => Promise<string | null>
}

/** Represents one tracked text part for a streaming assistant reply. */
interface AssistantTextPartState {
  ignored: boolean
  text: string
}

/** Represents one mutable assistant-text accumulator for the active prompt turn. */
interface AssistantTextAccumulator {
  assistantMessageId: string | null
  bufferedEventsByMessageId: Map<string, GlobalEvent[]>
  latestText: string
  partOrder: string[]
  partStatesById: Map<string, AssistantTextPartState>
}

/** Returns one promise that resolves after the provided delay. */
function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

/** Returns whether the provided error was caused by aborting the event stream. */
function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
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

/** Returns one empty assistant-text accumulator for a single prompt turn. */
function createAssistantTextAccumulator(): AssistantTextAccumulator {
  return {
    assistantMessageId: null,
    bufferedEventsByMessageId: new Map(),
    latestText: '',
    partOrder: [],
    partStatesById: new Map(),
  }
}

/** Returns the assistant text reconstructed from the known text-part snapshots. */
function getAccumulatedAssistantText(accumulator: AssistantTextAccumulator): string {
  return accumulator.partOrder
    .flatMap((partId) => {
      const partState = accumulator.partStatesById.get(partId)

      if (!partState || partState.ignored) {
        return []
      }

      return [partState.text]
    })
    .join('')
}

/** Emits one assistant-text snapshot only when the accumulated text has changed. */
async function emitAssistantTextUpdate(
  accumulator: AssistantTextAccumulator,
  assistantText: string,
  onAssistantTextUpdate: AgentAssistantTextUpdate | undefined,
): Promise<void> {
  if (!onAssistantTextUpdate || assistantText === accumulator.latestText) {
    return
  }

  accumulator.latestText = assistantText
  await onAssistantTextUpdate(assistantText)
}

/** Returns the matching assistant message identifier for the current prompt turn. */
function getPromptAssistantMessageId(
  event: GlobalEvent,
  sessionId: string,
  promptStartedAtMs: number,
): string | null {
  if (event.payload.type !== 'message.updated') {
    return null
  }

  const { info } = event.payload.properties

  if (
    info.role !== 'assistant' ||
    info.sessionID !== sessionId ||
    info.time.created < promptStartedAtMs
  ) {
    return null
  }

  return info.id
}

/** Returns the message identifier carried by one streamed part event. */
function getPartEventMessageId(event: GlobalEvent, sessionId: string): string | null {
  if (event.payload.type === 'message.part.updated') {
    return event.payload.properties.part.sessionID === sessionId
      ? event.payload.properties.part.messageID
      : null
  }

  if (event.payload.type === 'message.part.delta' || event.payload.type === 'message.part.removed') {
    return event.payload.properties.sessionID === sessionId ? event.payload.properties.messageID : null
  }

  return null
}

/** Buffers one part event until the assistant message identifier becomes known. */
function bufferPartEvent(
  accumulator: AssistantTextAccumulator,
  messageId: string,
  event: GlobalEvent,
): void {
  const bufferedEvents = accumulator.bufferedEventsByMessageId.get(messageId) ?? []

  bufferedEvents.push(event)
  accumulator.bufferedEventsByMessageId.set(messageId, bufferedEvents)
}

/** Applies one streamed text-part event and returns the latest assistant-text snapshot. */
function applyAssistantPartEvent(
  accumulator: AssistantTextAccumulator,
  event: GlobalEvent,
): string | null {
  if (!accumulator.assistantMessageId) {
    return null
  }

  if (event.payload.type === 'message.part.updated') {
    const { part } = event.payload.properties

    if (part.messageID !== accumulator.assistantMessageId || part.type !== 'text') {
      return null
    }

    if (!accumulator.partStatesById.has(part.id)) {
      accumulator.partOrder.push(part.id)
    }

    accumulator.partStatesById.set(part.id, {
      ignored: Boolean(part.ignored),
      text: part.text,
    })
    return getAccumulatedAssistantText(accumulator)
  }

  if (event.payload.type === 'message.part.delta') {
    const { delta, field, messageID, partID } = event.payload.properties

    if (messageID !== accumulator.assistantMessageId || field !== 'text') {
      return null
    }

    const previousState = accumulator.partStatesById.get(partID)

    if (!previousState) {
      accumulator.partOrder.push(partID)
    }

    accumulator.partStatesById.set(partID, {
      ignored: previousState?.ignored ?? false,
      text: `${previousState?.text ?? ''}${delta}`,
    })
    return getAccumulatedAssistantText(accumulator)
  }

  if (event.payload.type === 'message.part.removed') {
    const { messageID, partID } = event.payload.properties

    if (messageID !== accumulator.assistantMessageId || !accumulator.partStatesById.has(partID)) {
      return null
    }

    accumulator.partStatesById.delete(partID)
    accumulator.partOrder = accumulator.partOrder.filter((candidatePartId) => candidatePartId !== partID)
    return getAccumulatedAssistantText(accumulator)
  }

  return null
}

/** Flushes any buffered part events that arrived before the assistant message was identified. */
async function flushBufferedPartEvents(
  accumulator: AssistantTextAccumulator,
  assistantMessageId: string,
  onAssistantTextUpdate: AgentAssistantTextUpdate | undefined,
): Promise<void> {
  const bufferedEvents = accumulator.bufferedEventsByMessageId.get(assistantMessageId)

  if (!bufferedEvents) {
    return
  }

  accumulator.bufferedEventsByMessageId.delete(assistantMessageId)

  for (const event of bufferedEvents) {
    const assistantText = applyAssistantPartEvent(accumulator, event)

    if (assistantText !== null) {
      await emitAssistantTextUpdate(accumulator, assistantText, onAssistantTextUpdate)
    }
  }
}

/** Processes one prompt-related event and emits assistant-text snapshots when needed. */
async function processPromptEvent(
  accumulator: AssistantTextAccumulator,
  event: GlobalEvent,
  sessionId: string,
  promptStartedAtMs: number,
  onAssistantTextUpdate: AgentAssistantTextUpdate | undefined,
): Promise<void> {
  const assistantMessageId = getPromptAssistantMessageId(event, sessionId, promptStartedAtMs)

  if (assistantMessageId && accumulator.assistantMessageId !== assistantMessageId) {
    accumulator.assistantMessageId = assistantMessageId
    await flushBufferedPartEvents(accumulator, assistantMessageId, onAssistantTextUpdate)
  }

  const partEventMessageId = getPartEventMessageId(event, sessionId)

  if (!partEventMessageId) {
    return
  }

  if (!accumulator.assistantMessageId) {
    bufferPartEvent(accumulator, partEventMessageId, event)
    return
  }

  if (partEventMessageId !== accumulator.assistantMessageId) {
    return
  }

  const assistantText = applyAssistantPartEvent(accumulator, event)

  if (assistantText !== null) {
    await emitAssistantTextUpdate(accumulator, assistantText, onAssistantTextUpdate)
  }
}

/** Returns whether one streamed event is the matching OpenCode session.error payload. */
function getSessionErrorMessage(event: GlobalEvent, sessionId: string): string | null {
  if (event.payload.type !== 'session.error' || event.payload.properties.sessionID !== sessionId) {
    return null
  }

  return getOpenCodeErrorText(event.payload.properties.error) ?? 'OpenCode reported a session error.'
}

/** Creates one prompt monitor that watches OpenCode events for a specific prompt turn. */
export async function createOpenCodePromptMonitor(
  client: OpencodeClient,
  sessionId: string,
  promptStartedAtMs: number,
  onAssistantTextUpdate?: AgentAssistantTextUpdate,
): Promise<OpenCodePromptMonitor> {
  const controller = new AbortController()
  const accumulator = createAssistantTextAccumulator()
  let resolveSessionError: ((message: string | null) => void) | null = null
  const sessionErrorPromise = new Promise<string | null>((resolve) => {
    resolveSessionError = resolve
  })
  const resolveSessionErrorOnce = (message: string | null) => {
    if (!resolveSessionError) {
      return
    }

    resolveSessionError(message)
    resolveSessionError = null
  }

  try {
    const events = await client.global.event({
      signal: controller.signal,
    })

    void (async () => {
      try {
        for await (const event of events.stream) {
          const sessionErrorMessage = getSessionErrorMessage(event, sessionId)

          if (sessionErrorMessage) {
            resolveSessionErrorOnce(sessionErrorMessage)
            return
          }

          await processPromptEvent(
            accumulator,
            event,
            sessionId,
            promptStartedAtMs,
            onAssistantTextUpdate,
          )
        }
      } catch (error) {
        if (!isAbortError(error)) {
          resolveSessionErrorOnce(null)
          return
        }
      }

      resolveSessionErrorOnce(null)
    })()

    return {
      cancel: () => {
        controller.abort()
        resolveSessionErrorOnce(null)
      },
      waitForSessionError: async (timeoutMs: number) => {
        return await Promise.race([
          sessionErrorPromise,
          wait(timeoutMs).then(() => null),
        ])
      },
    }
  } catch {
    resolveSessionErrorOnce(null)
    return {
      cancel: () => undefined,
      waitForSessionError: async () => null,
    }
  }
}
