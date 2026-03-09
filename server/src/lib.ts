import { createHash, randomUUID } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import type { Server, ServerWebSocket } from 'bun'

import { getServerPort } from './config'
import type {
  ClientSessionMessage,
  ConversationEntry,
  ConversationEntryMessage,
  ServerSessionMessage,
  SessionErrorMessage,
  SessionSocketData,
} from './session/session-types'

const sourceDirectory = path.dirname(fileURLToPath(import.meta.url))

/** Represents the JSON payload returned by the minimal health endpoint. */
export interface ServerHealthPayload {
  instanceId: string
  ok: true
  serverType: string
  serverTypeHash: string
  startedAt: string
}

/** Represents the configurable inputs for starting the minimal Bun server. */
export interface StartServerOptions {
  port?: number
}

/** Represents one running Bun server plus its cleanup hook. */
export interface ServerHandle {
  server: Server<SessionSocketData>
  stop(): Promise<void>
}

/** Returns the stable server type label for the minimal Bun backend. */
function getServerType(): string {
  return 'minimal'
}

/** Returns the sorted file paths that contribute to the server identity hash. */
function getServerHashInputPaths(): string[] {
  const directoriesToScan = [sourceDirectory]
  const discoveredPaths: string[] = []

  while (directoriesToScan.length > 0) {
    const currentDirectory = directoriesToScan.pop()

    if (!currentDirectory) {
      continue
    }

    for (const entry of readdirSync(currentDirectory, { withFileTypes: true })) {
      const entryPath = path.join(currentDirectory, entry.name)

      if (entry.isDirectory()) {
        directoriesToScan.push(entryPath)
        continue
      }

      if (entry.isFile() && entry.name.endsWith('.ts')) {
        discoveredPaths.push(entryPath)
      }
    }
  }

  discoveredPaths.sort()
  discoveredPaths.push(path.resolve(sourceDirectory, '..', 'package.json'))
  return discoveredPaths
}

/** Returns the code-derived hash for the currently running server build. */
function getServerTypeHash(): string {
  const hash = createHash('sha256')

  for (const filePath of getServerHashInputPaths()) {
    hash.update(path.relative(sourceDirectory, filePath))
    hash.update('\n')
    hash.update(readFileSync(filePath))
    hash.update('\n')
  }

  return hash.digest('hex').slice(0, 12)
}

/** Returns the short identifier for one running backend instance. */
function createServerInstanceId(): string {
  return randomUUID().slice(0, 8)
}

/** Returns the JSON response used by the minimal server health endpoint. */
function createJsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  })
}

/** Returns one placeholder assistant reply for the first WebSocket integration. */
function createPlaceholderAssistantReply(userText: string): string {
  const trimmedText = userText.trim()

  if (trimmedText.toLowerCase() === '/error') {
    throw new Error('The placeholder backend reply failed.')
  }

  if (trimmedText.length === 0) {
    throw new Error('The chat backend cannot send an empty message.')
  }

  return `Placeholder assistant reply from the Bun backend: ${trimmedText}`
}

/** Returns one new transcript entry sent from the Bun chat socket. */
function createConversationEntry(role: ConversationEntry['role'], content: string): ConversationEntry {
  return {
    id: randomUUID(),
    role,
    content,
  }
}

/** Returns one renderer-safe session error payload. */
function createSessionErrorMessage(message: string): SessionErrorMessage {
  return {
    type: 'session_error',
    message,
  }
}

/** Sends one typed session message across the Bun chat socket. */
function sendServerSessionMessage(
  socket: ServerWebSocket<SessionSocketData>,
  message: ServerSessionMessage,
): void {
  socket.send(JSON.stringify(message))
}

/** Sends one renderer-safe error message across the Bun chat socket. */
function sendSessionError(socket: ServerWebSocket<SessionSocketData>, message: string): void {
  sendServerSessionMessage(socket, createSessionErrorMessage(message))
}

/** Returns one parsed client session message or throws a renderer-safe error. */
function parseClientSessionMessage(message: string | Buffer): ClientSessionMessage {
  if (typeof message !== 'string') {
    throw new Error('The chat socket only accepts text messages.')
  }

  const parsedMessage = JSON.parse(message) as Partial<ClientSessionMessage> & {
    sessionId?: unknown
    text?: unknown
    type?: unknown
  }

  if (parsedMessage.type === 'connect') {
    if (typeof parsedMessage.sessionId !== 'string' || parsedMessage.sessionId.trim().length === 0) {
      throw new Error('The connect message must include a sessionId.')
    }

    return {
      type: 'connect',
      sessionId: parsedMessage.sessionId,
    }
  }

  if (parsedMessage.type === 'user_message') {
    if (typeof parsedMessage.sessionId !== 'string' || parsedMessage.sessionId.trim().length === 0) {
      throw new Error('The user_message event must include a sessionId.')
    }

    if (typeof parsedMessage.text !== 'string') {
      throw new Error('The user_message event must include text.')
    }

    return {
      type: 'user_message',
      sessionId: parsedMessage.sessionId,
      text: parsedMessage.text,
    }
  }

  throw new Error('The chat socket received an unsupported message type.')
}

/** Returns whether the socket is ready to accept one user message for the session. */
function canHandleUserMessage(
  socket: ServerWebSocket<SessionSocketData>,
  sessionId: string,
): boolean {
  if (!socket.data.sessionId) {
    sendSessionError(socket, 'The chat socket must connect to a session before sending messages.')
    return false
  }

  if (socket.data.sessionId !== sessionId) {
    sendSessionError(socket, 'The user message sessionId did not match the connected session.')
    return false
  }

  return true
}

/** Handles one parsed client session message on the Bun chat socket. */
function handleClientSessionMessage(
  socket: ServerWebSocket<SessionSocketData>,
  message: ClientSessionMessage,
): void {
  if (message.type === 'connect') {
    socket.data.sessionId = message.sessionId
    return
  }

  if (!canHandleUserMessage(socket, message.sessionId)) {
    return
  }

  const replyMessage: ConversationEntryMessage = {
    type: 'conversation_entry',
    entry: createConversationEntry('assistant', createPlaceholderAssistantReply(message.text)),
  }
  sendServerSessionMessage(socket, replyMessage)
}

/** Starts the minimal Bun server with a health-check route and placeholder chat socket. */
export function startServer(options: StartServerOptions = {}): ServerHandle {
  const port = options.port ?? getServerPort()
  const healthPayload: ServerHealthPayload = {
    instanceId: createServerInstanceId(),
    ok: true,
    serverType: getServerType(),
    serverTypeHash: getServerTypeHash(),
    startedAt: new Date().toISOString(),
  }
  const server = Bun.serve<SessionSocketData>({
    port,
    fetch(request, server) {
      const url = new URL(request.url)

      if (url.pathname === '/health') {
        return createJsonResponse(healthPayload)
      }

      if (url.pathname === '/ws') {
        const didUpgrade = server.upgrade(request, {
          data: {
            sessionId: null,
          },
        })

        if (didUpgrade) {
          return
        }

        return createJsonResponse(
          {
            message: 'The chat socket upgrade failed.',
          },
          { status: 400 },
        )
      }

      return new Response('Not found.', { status: 404 })
    },
    websocket: {
      message(socket, message) {
        try {
          handleClientSessionMessage(socket, parseClientSessionMessage(message))
        } catch (error) {
          sendSessionError(
            socket,
            error instanceof Error ? error.message : 'The chat socket request failed.',
          )
        }
      },
    },
  })

  return {
    server,
    async stop(): Promise<void> {
      server.stop(true)
    },
  }
}
