import { createServer } from 'node:net'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import type {
  ConversationEntryMessage,
  ServerSessionMessage,
  SessionSnapshotMessage,
} from '../types/session'
import { SessionClient } from './session-client'

const electronProjectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

/** Returns an available TCP port for the live Rust backend test process. */
export async function getAvailablePort(): Promise<number> {
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

/** Waits for the Rust backend health endpoint to become reachable. */
export async function waitForHealth(port: number): Promise<void> {
  const healthUrl = `http://127.0.0.1:${port}/health`

  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const response = await fetch(healthUrl)

      if (response.ok) {
        return
      }
    } catch {
      // Keep polling until the Rust server is ready.
    }

    await Bun.sleep(250)
  }

  throw new Error('The Rust backend did not become healthy in time.')
}

/** Starts the live Rust backend test process on the provided TCP port. */
export async function startRustServer(port: number): Promise<ReturnType<typeof Bun.spawn>> {
  const serverProcess = Bun.spawn(
    ['cargo', 'run', '--quiet', '--manifest-path', '../server/Cargo.toml'],
    {
      cwd: electronProjectRoot,
      env: {
        ...process.env,
        VIDE_SERVER_PORT: String(port),
      },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )

  try {
    await waitForHealth(port)
    return serverProcess
  } catch (error) {
    const stderr = await new Response(serverProcess.stderr).text()
    serverProcess.kill()
    await serverProcess.exited
    throw new Error(
      error instanceof Error ? `${error.message}\n${stderr}`.trim() : 'The Rust backend failed to start.',
    )
  }
}

/** Stops the live Rust backend test process after the integration test finishes. */
export async function stopRustServer(serverProcess: ReturnType<typeof Bun.spawn>): Promise<void> {
  serverProcess.kill()
  await serverProcess.exited
}

/** Waits for one server session message that matches the provided predicate. */
export async function waitForServerMessage<T extends ServerSessionMessage>(
  client: SessionClient,
  predicate: (message: ServerSessionMessage) => message is T,
): Promise<T> {
  return await new Promise<T>((resolveMessage, rejectMessage) => {
    const timeoutId = setTimeout(() => {
      unsubscribe()
      rejectMessage(new Error('The expected session message did not arrive in time.'))
    }, 10_000)

    const unsubscribe = client.subscribe((event) => {
      if (event.type === 'error') {
        clearTimeout(timeoutId)
        unsubscribe()
        rejectMessage(new Error(event.message))
        return
      }

      if (event.type === 'message' && predicate(event.message)) {
        clearTimeout(timeoutId)
        unsubscribe()
        resolveMessage(event.message)
      }
    })
  })
}

/** Returns whether one server message is the initial session snapshot. */
export function isSessionSnapshotMessage(
  message: ServerSessionMessage,
): message is SessionSnapshotMessage {
  return message.type === 'session_snapshot'
}

/** Returns whether one server message appends a user transcript entry. */
export function isUserConversationEntry(
  message: ServerSessionMessage,
): message is ConversationEntryMessage {
  return message.type === 'conversation_entry' && message.entry.role === 'user'
}

/** Returns whether one server message appends an assistant transcript entry. */
export function isAssistantConversationEntry(
  message: ServerSessionMessage,
): message is ConversationEntryMessage {
  return message.type === 'conversation_entry' && message.entry.role === 'assistant'
}
