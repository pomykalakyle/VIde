import { createServer } from 'node:net'

import { expect, test } from 'bun:test'

import {
  createStaticAgentRuntime,
  createStreamingAgentRuntime,
  createThrowingAgentRuntime,
} from './agent/fake-agent-runtime'
import type {
  SessionContainerManager,
  SessionContainerSnapshot,
} from './container/session-container'
import { startServer, type ServerHandle } from './lib'
import type {
  ConversationEntryDeltaMessage,
  ConversationEntryMessage,
  ServerSessionMessage,
  SessionErrorMessage,
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

/** Returns one ready session-container snapshot for server tests. */
function createTestSessionContainerSnapshot(
  overrides: Partial<SessionContainerSnapshot> = {},
): SessionContainerSnapshot {
  return {
    baseUrl: 'http://127.0.0.1:4096',
    containerId: 'test-container-id',
    containerImage: 'test-image:latest',
    containerName: 'test-container',
    error: '',
    openCodeError: '',
    openCodeStatus: 'ready',
    openCodeVersion: '1.2.22',
    startedAt: '2026-01-01T00:00:00.000Z',
    status: 'ready',
    ...overrides,
  }
}

/** Returns one static session-container manager for Bun server tests. */
function createTestSessionContainerManager(
  overrides: Partial<SessionContainerSnapshot> = {},
): SessionContainerManager {
  let snapshot = createTestSessionContainerSnapshot(overrides)

  return {
    getSnapshot(): SessionContainerSnapshot {
      return { ...snapshot }
    },
    async start(): Promise<void> {
      snapshot = {
        ...snapshot,
        status: 'ready',
      }
    },
    async stop(): Promise<void> {
      snapshot = {
        ...snapshot,
        baseUrl: null,
        containerId: null,
        containerName: null,
        error: '',
        openCodeError: '',
        openCodeStatus: 'stopped',
        openCodeVersion: null,
        startedAt: null,
        status: 'stopped',
      }
    },
  }
}

/** Verifies the health endpoint returns stable server identity metadata. */
test('server health endpoint returns ok', async () => {
  const port = await getAvailablePort()
  const handle: ServerHandle = startServer({
    agentRuntime: createStaticAgentRuntime({
      assistantText: 'Fake OpenCode assistant reply.',
    }),
    port,
    sessionContainerManager: createTestSessionContainerManager(),
  })

  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`)
    const body = (await response.json()) as Record<string, unknown>

    expect(response.status).toBe(200)
    expect(body.ok).toBe(true)
    expect(typeof body.startedAt).toBe('string')
    expect(typeof body.instanceId).toBe('string')
    expect(typeof body.serverType).toBe('string')
    expect(typeof body.serverTypeHash).toBe('string')
    expect(body.containerStatus).toBe('ready')
    expect(body.containerId).toBe('test-container-id')
    expect(body.containerName).toBe('test-container')
    expect(body.openCodeStatus).toBe('ready')
    expect(body.openCodeVersion).toBe('1.2.22')
  } finally {
    await handle.stop()
  }
})

/** Verifies unknown routes remain unavailable on the minimal server. */
test('server returns not found for unknown routes', async () => {
  const port = await getAvailablePort()
  const handle: ServerHandle = startServer({
    agentRuntime: createStaticAgentRuntime({
      assistantText: 'Fake OpenCode assistant reply.',
    }),
    port,
    sessionContainerManager: createTestSessionContainerManager(),
  })

  try {
    const response = await fetch(`http://127.0.0.1:${port}/missing`)

    expect(response.status).toBe(404)
  } finally {
    await handle.stop()
  }
})

/** Opens one WebSocket connection to the provided test server URL. */
async function openWebSocket(url: string): Promise<WebSocket> {
  return await new Promise<WebSocket>((resolveSocket, rejectSocket) => {
    const socket = new WebSocket(url)

    socket.addEventListener(
      'open',
      () => {
        resolveSocket(socket)
      },
      { once: true },
    )
    socket.addEventListener(
      'error',
      () => {
        rejectSocket(new Error('The test WebSocket connection failed to open.'))
      },
      { once: true },
    )
  })
}

/** Waits for the next text message emitted by the test WebSocket. */
async function waitForSocketMessage(socket: WebSocket): Promise<string> {
  return await new Promise<string>((resolveMessage, rejectMessage) => {
    const handleMessage = (event: MessageEvent) => {
      cleanup()
      resolveMessage(String(event.data))
    }
    const handleError = () => {
      cleanup()
      rejectMessage(new Error('The test WebSocket connection failed before a message arrived.'))
    }
    const handleClose = () => {
      cleanup()
      rejectMessage(new Error('The test WebSocket connection closed before a message arrived.'))
    }
    const cleanup = () => {
      socket.removeEventListener('message', handleMessage)
      socket.removeEventListener('error', handleError)
      socket.removeEventListener('close', handleClose)
    }

    socket.addEventListener('message', handleMessage, { once: true })
    socket.addEventListener('error', handleError, { once: true })
    socket.addEventListener('close', handleClose, { once: true })
  })
}

/** Waits for the next parsed server session message emitted by the test WebSocket. */
async function waitForServerSessionMessage(socket: WebSocket): Promise<ServerSessionMessage> {
  return JSON.parse(await waitForSocketMessage(socket)) as ServerSessionMessage
}

/** Verifies the placeholder chat socket returns one assistant reply. */
test('server websocket returns placeholder assistant reply', async () => {
  const port = await getAvailablePort()
  const handle: ServerHandle = startServer({
    agentRuntime: createStaticAgentRuntime({
      assistantText: (input) => `Placeholder assistant reply from the Bun backend: ${input.userText}`,
    }),
    port,
    sessionContainerManager: createTestSessionContainerManager(),
  })
  const socket = await openWebSocket(`ws://127.0.0.1:${port}/ws`)

  try {
    socket.send(
      JSON.stringify({
        type: 'connect',
        sessionId: 'test-session',
      }),
    )
    socket.send(
      JSON.stringify({
        type: 'user_message',
        sessionId: 'test-session',
        text: 'hello backend',
      }),
    )

    const deltaMessage = (await waitForServerSessionMessage(socket)) as ConversationEntryDeltaMessage
    const finalMessage = (await waitForServerSessionMessage(socket)) as ConversationEntryMessage

    expect(deltaMessage.type).toBe('conversation_entry_delta')
    expect(deltaMessage.entry.role).toBe('assistant')
    expect(deltaMessage.entry.content).toContain('hello backend')
    expect(finalMessage.type).toBe('conversation_entry')
    expect(finalMessage.entry.id).toBe(deltaMessage.entry.id)
    expect(finalMessage.entry.content).toContain('hello backend')
  } finally {
    socket.close()
    await handle.stop()
  }
})

/** Verifies the chat socket can stream multiple assistant snapshots before the final reply. */
test('server websocket streams assistant snapshots before the final reply', async () => {
  const port = await getAvailablePort()
  const handle: ServerHandle = startServer({
    agentRuntime: createStreamingAgentRuntime({
      assistantTextSnapshots: ['Hello', 'Hello there'],
      finalAssistantText: 'Hello there from the streaming backend.',
    }),
    port,
    sessionContainerManager: createTestSessionContainerManager(),
  })
  const socket = await openWebSocket(`ws://127.0.0.1:${port}/ws`)

  try {
    socket.send(
      JSON.stringify({
        type: 'connect',
        sessionId: 'test-session',
      }),
    )
    socket.send(
      JSON.stringify({
        type: 'user_message',
        sessionId: 'test-session',
        text: 'stream something',
      }),
    )

    const firstDeltaMessage = (await waitForServerSessionMessage(socket)) as ConversationEntryDeltaMessage
    const secondDeltaMessage = (await waitForServerSessionMessage(socket)) as ConversationEntryDeltaMessage
    const finalMessage = (await waitForServerSessionMessage(socket)) as ConversationEntryMessage

    expect(firstDeltaMessage.type).toBe('conversation_entry_delta')
    expect(firstDeltaMessage.entry.content).toBe('Hello')
    expect(secondDeltaMessage.type).toBe('conversation_entry_delta')
    expect(secondDeltaMessage.entry.id).toBe(firstDeltaMessage.entry.id)
    expect(secondDeltaMessage.entry.content).toBe('Hello there')
    expect(finalMessage.type).toBe('conversation_entry')
    expect(finalMessage.entry.id).toBe(firstDeltaMessage.entry.id)
    expect(finalMessage.entry.content).toBe('Hello there from the streaming backend.')
  } finally {
    socket.close()
    await handle.stop()
  }
})

/** Verifies the placeholder chat socket surfaces renderer-safe errors. */
test('server websocket returns session errors for placeholder failures', async () => {
  const port = await getAvailablePort()
  const handle: ServerHandle = startServer({
    agentRuntime: createThrowingAgentRuntime('The placeholder backend reply failed.'),
    port,
    sessionContainerManager: createTestSessionContainerManager(),
  })
  const socket = await openWebSocket(`ws://127.0.0.1:${port}/ws`)

  try {
    socket.send(
      JSON.stringify({
        type: 'connect',
        sessionId: 'test-session',
      }),
    )
    socket.send(
      JSON.stringify({
        type: 'user_message',
        sessionId: 'test-session',
        text: '/error',
      }),
    )

    const rawMessage = await waitForSocketMessage(socket)
    const message = JSON.parse(rawMessage) as SessionErrorMessage

    expect(message.type).toBe('session_error')
    expect(message.message).toContain('failed')
  } finally {
    socket.close()
    await handle.stop()
  }
})

/** Verifies a streamed assistant turn can surface a later renderer-safe session error. */
test('server websocket returns session errors after partial assistant streaming', async () => {
  const port = await getAvailablePort()
  const handle: ServerHandle = startServer({
    agentRuntime: {
      async runTurn(input) {
        await input.onAssistantTextUpdate?.('Partial assistant reply before failure.')
        throw new Error('The streamed backend reply failed.')
      },
    },
    port,
    sessionContainerManager: createTestSessionContainerManager(),
  })
  const socket = await openWebSocket(`ws://127.0.0.1:${port}/ws`)

  try {
    socket.send(
      JSON.stringify({
        type: 'connect',
        sessionId: 'test-session',
      }),
    )
    socket.send(
      JSON.stringify({
        type: 'user_message',
        sessionId: 'test-session',
        text: 'stream then fail',
      }),
    )

    const deltaMessage = (await waitForServerSessionMessage(socket)) as ConversationEntryDeltaMessage
    const errorMessage = (await waitForServerSessionMessage(socket)) as SessionErrorMessage

    expect(deltaMessage.type).toBe('conversation_entry_delta')
    expect(deltaMessage.entry.content).toBe('Partial assistant reply before failure.')
    expect(errorMessage.type).toBe('session_error')
    expect(errorMessage.message).toContain('failed')
  } finally {
    socket.close()
    await handle.stop()
  }
})
