import { createServer } from 'node:net'

import { expect, test } from 'bun:test'

import { createThrowingAgentRuntime } from './agent/fake-agent-runtime'
import { startSessionServer, type SessionServerHandle } from './lib'
import type {
  ConversationEntryMessage,
  ServerSessionMessage,
  SessionErrorMessage,
  SessionSnapshotMessage,
} from './session/session-types'

/** Returns an available TCP port for starting a temporary test server. */
async function getAvailablePort(): Promise<number> {
  return await new Promise<number>((resolvePort, rejectPort) => {
    const server = createServer()

    server.once('error', rejectPort)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()

      if (!address || typeof address === 'string') {
        rejectPort(new Error('The test could not reserve a TCP port.'))
        return
      }

      server.close((error) => {
        if (error) {
          rejectPort(error)
          return
        }

        resolvePort(address.port)
      })
    })
  })
}

/** Returns whether one server message is the initial session snapshot. */
function isSessionSnapshotMessage(
  message: ServerSessionMessage,
): message is SessionSnapshotMessage {
  return message.type === 'session_snapshot'
}

/** Returns whether one server message appends a user transcript entry. */
function isUserConversationEntry(
  message: ServerSessionMessage,
): message is ConversationEntryMessage {
  return message.type === 'conversation_entry' && message.entry.role === 'user'
}

/** Returns whether one server message appends an assistant transcript entry. */
function isAssistantConversationEntry(
  message: ServerSessionMessage,
): message is ConversationEntryMessage {
  return message.type === 'conversation_entry' && message.entry.role === 'assistant'
}

/** Returns whether one server message is a renderer-safe session error. */
function isSessionErrorMessage(message: ServerSessionMessage): message is SessionErrorMessage {
  return message.type === 'session_error'
}

/** Represents one buffered websocket message queue for session-server tests. */
class SessionMessageQueue {
  #messages: ServerSessionMessage[] = []
  #waiters: Array<{
    predicate: (message: ServerSessionMessage) => boolean
    reject: (error: Error) => void
    resolve: (message: ServerSessionMessage) => void
    timeoutId: ReturnType<typeof setTimeout>
  }> = []

  /** Attaches the queue to one websocket and buffers future server messages. */
  constructor(socket: WebSocket) {
    socket.addEventListener('message', (event) => {
      this.#push(JSON.parse(String(event.data)) as ServerSessionMessage)
    })
  }

  /** Waits for the next buffered message that matches the provided predicate. */
  async next<T extends ServerSessionMessage>(
    predicate: (message: ServerSessionMessage) => message is T,
    timeoutMs = 5_000,
  ): Promise<T> {
    const bufferedMessage = this.#messages.find(predicate)

    if (bufferedMessage) {
      this.#messages.splice(this.#messages.indexOf(bufferedMessage), 1)
      return bufferedMessage
    }

    return await new Promise<T>((resolveMessage, rejectMessage) => {
      const timeoutId = setTimeout(() => {
        this.#waiters = this.#waiters.filter((waiter) => waiter.timeoutId !== timeoutId)
        rejectMessage(new Error('The expected session message did not arrive in time.'))
      }, timeoutMs)

      this.#waiters.push({
        predicate,
        reject: rejectMessage,
        resolve: (message) => resolveMessage(message as T),
        timeoutId,
      })
    })
  }

  /** Verifies that no buffered or future message matches the predicate during the timeout. */
  async expectNoMatch(
    predicate: (message: ServerSessionMessage) => boolean,
    timeoutMs = 250,
  ): Promise<void> {
    if (this.#messages.some(predicate)) {
      throw new Error('A disallowed session message was already buffered.')
    }

    await new Promise<void>((resolveNoMatch, rejectNoMatch) => {
      const timeoutId = setTimeout(() => {
        this.#waiters = this.#waiters.filter((waiter) => waiter.timeoutId !== timeoutId)
        resolveNoMatch()
      }, timeoutMs)

      this.#waiters.push({
        predicate,
        reject: rejectNoMatch,
        resolve: () => rejectNoMatch(new Error('A disallowed session message arrived.')),
        timeoutId,
      })
    })
  }

  /** Pushes one parsed server message into the queue and resolves matching waiters. */
  #push(message: ServerSessionMessage): void {
    const waiter = this.#waiters.find((candidate) => candidate.predicate(message))

    if (waiter) {
      clearTimeout(waiter.timeoutId)
      this.#waiters = this.#waiters.filter((candidate) => candidate !== waiter)
      waiter.resolve(message)
      return
    }

    this.#messages.push(message)
  }
}

/** Opens one websocket connection to the provided session-server URL. */
async function connectWebSocket(url: string): Promise<WebSocket> {
  return await new Promise<WebSocket>((resolveSocket, rejectSocket) => {
    const socket = new WebSocket(url)

    socket.addEventListener('open', () => resolveSocket(socket), { once: true })
    socket.addEventListener(
      'error',
      () => rejectSocket(new Error('The websocket could not connect to the session server.')),
      { once: true },
    )
  })
}

/** Verifies the server emits a session error and no assistant entry when the runtime throws. */
test('session server emits session_error without appending an assistant entry when the runtime fails', async () => {
  const port = await getAvailablePort()
  const handle: SessionServerHandle = startSessionServer({
    agentRuntime: createThrowingAgentRuntime('Fake runtime failure.'),
    port,
  })
  const socket = await connectWebSocket(`ws://127.0.0.1:${port}/ws`)
  const queue = new SessionMessageQueue(socket)

  try {
    socket.send(
      JSON.stringify({
        sessionId: 'server-test',
        type: 'connect',
      }),
    )

    const snapshot = await queue.next(isSessionSnapshotMessage)
    expect(snapshot.entries).toEqual([])

    socket.send(
      JSON.stringify({
        sessionId: 'server-test',
        text: 'Trigger the fake runtime failure.',
        type: 'user_message',
      }),
    )

    const userEntry = await queue.next(isUserConversationEntry)
    const sessionError = await queue.next(isSessionErrorMessage)

    expect(userEntry.entry.content).toBe('Trigger the fake runtime failure.')
    expect(sessionError.message).toBe('Fake runtime failure.')

    await queue.expectNoMatch(isAssistantConversationEntry)
  } finally {
    socket.close()
    await handle.stop()
  }
})
