import { createServer } from 'node:net'

import { expect, test } from 'bun:test'

import { startServer, type ServerHandle } from './lib'
import type { ConversationEntryMessage, SessionErrorMessage } from './session/session-types'

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

/** Verifies the health endpoint returns stable server identity metadata. */
test('server health endpoint returns ok', async () => {
  const port = await getAvailablePort()
  const handle: ServerHandle = startServer({ port })

  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`)
    const body = (await response.json()) as Record<string, unknown>

    expect(response.status).toBe(200)
    expect(body.ok).toBe(true)
    expect(typeof body.startedAt).toBe('string')
    expect(typeof body.instanceId).toBe('string')
    expect(typeof body.serverType).toBe('string')
    expect(typeof body.serverTypeHash).toBe('string')
  } finally {
    await handle.stop()
  }
})

/** Verifies unknown routes remain unavailable on the minimal server. */
test('server returns not found for unknown routes', async () => {
  const port = await getAvailablePort()
  const handle: ServerHandle = startServer({ port })

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

/** Verifies the placeholder chat socket returns one assistant reply. */
test('server websocket returns placeholder assistant reply', async () => {
  const port = await getAvailablePort()
  const handle: ServerHandle = startServer({ port })
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

    const rawMessage = await waitForSocketMessage(socket)
    const message = JSON.parse(rawMessage) as ConversationEntryMessage

    expect(message.type).toBe('conversation_entry')
    expect(message.entry.role).toBe('assistant')
    expect(message.entry.content).toContain('hello backend')
  } finally {
    socket.close()
    await handle.stop()
  }
})

/** Verifies the placeholder chat socket surfaces renderer-safe errors. */
test('server websocket returns session errors for placeholder failures', async () => {
  const port = await getAvailablePort()
  const handle: ServerHandle = startServer({ port })
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
