import type { Server, ServerWebSocket } from 'bun'

import { createAgentRuntime } from './agent/create-agent-runtime'
import type { AgentRuntime } from './agent/agent-runtime'
import { getServerPort } from './config'
import type {
  ClientSessionMessage,
  ConversationEntry,
  ConversationEntryMessage,
  ConversationRole,
  ServerSessionMessage,
  SessionConnectMessage,
  SessionErrorMessage,
  SessionSnapshotMessage,
  SessionSocketData,
  UserMessageRequest,
} from './session/session-types'

/** Represents one in-memory session record shared across connected clients. */
interface ServerSession {
  entries: ConversationEntry[]
  nextEntryId: number
  sockets: Set<ServerWebSocket<SessionSocketData>>
}

/** Represents the configurable inputs for starting the Bun session server. */
export interface StartSessionServerOptions {
  agentRuntime?: AgentRuntime
  port?: number
}

/** Represents one running Bun session server plus its cleanup hooks. */
export interface SessionServerHandle {
  server: Server<SessionSocketData>
  stop(): Promise<void>
}

/** Represents the shared in-memory session registry for the Bun backend. */
class SharedServerState {
  readonly sessions = new Map<string, ServerSession>()

  /** Returns one existing session or creates an empty session on demand. */
  getOrCreateSession(sessionId: string): ServerSession {
    const existingSession = this.sessions.get(sessionId)

    if (existingSession) {
      return existingSession
    }

    const session: ServerSession = {
      entries: [],
      nextEntryId: 1,
      sockets: new Set(),
    }
    this.sessions.set(sessionId, session)
    return session
  }
}

/** Returns whether one unknown value is a string-keyed object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** Returns whether one unknown value is a connect message. */
function isSessionConnectMessage(value: unknown): value is SessionConnectMessage {
  return (
    isRecord(value) &&
    value.type === 'connect' &&
    typeof value.sessionId === 'string' &&
    value.sessionId.length > 0
  )
}

/** Returns whether one unknown value is a user transcript submission. */
function isUserMessageRequest(value: unknown): value is UserMessageRequest {
  return (
    isRecord(value) &&
    value.type === 'user_message' &&
    typeof value.sessionId === 'string' &&
    value.sessionId.length > 0 &&
    typeof value.text === 'string'
  )
}

/** Parses one websocket payload into a validated client session message. */
function parseClientSessionMessage(payload: string): ClientSessionMessage | null {
  try {
    const message = JSON.parse(payload) as unknown

    if (isSessionConnectMessage(message) || isUserMessageRequest(message)) {
      return message
    }

    return null
  } catch {
    return null
  }
}

/** Builds one session snapshot message for the targeted session. */
function createSessionSnapshotMessage(
  sessionId: string,
  session: ServerSession,
): SessionSnapshotMessage {
  return {
    type: 'session_snapshot',
    sessionId,
    entries: [...session.entries],
  }
}

/** Builds one append-only transcript event for a single entry. */
function createConversationEntryMessage(entry: ConversationEntry): ConversationEntryMessage {
  return {
    type: 'conversation_entry',
    entry,
  }
}

/** Builds one renderer-safe websocket error message. */
function createSessionErrorMessage(message: string): SessionErrorMessage {
  return {
    type: 'session_error',
    message,
  }
}

/** Sends one JSON-encoded server message across the active websocket. */
function sendServerMessage(
  socket: ServerWebSocket<SessionSocketData>,
  message: ServerSessionMessage,
): void {
  socket.send(JSON.stringify(message))
}

/** Creates one new transcript entry with a stable server-owned identifier. */
function createEntry(
  session: ServerSession,
  role: ConversationRole,
  content: string,
): ConversationEntry {
  const entry: ConversationEntry = {
    id: String(session.nextEntryId),
    role,
    content,
  }
  session.nextEntryId += 1
  return entry
}

/** Broadcasts one server message to every client currently joined to a session. */
function broadcastToSession(session: ServerSession, message: ServerSessionMessage): void {
  for (const socket of session.sockets) {
    sendServerMessage(socket, message)
  }
}

/** Removes one socket from its joined session when the connection closes. */
function removeSocketFromSession(
  state: SharedServerState,
  socket: ServerWebSocket<SessionSocketData>,
): void {
  const { sessionId } = socket.data

  if (!sessionId) {
    return
  }

  const session = state.sessions.get(sessionId)

  if (!session) {
    return
  }

  session.sockets.delete(socket)
}

/** Handles the first connect message and hydrates the joining client. */
function handleConnectMessage(
  state: SharedServerState,
  socket: ServerWebSocket<SessionSocketData>,
  message: SessionConnectMessage,
): void {
  const session = state.getOrCreateSession(message.sessionId)
  socket.data.sessionId = message.sessionId
  session.sockets.add(socket)
  sendServerMessage(socket, createSessionSnapshotMessage(message.sessionId, session))
}

/** Appends one transcript entry to the session and returns the stored entry. */
function appendEntry(
  session: ServerSession,
  role: ConversationRole,
  content: string,
): ConversationEntry {
  const entry = createEntry(session, role, content)
  session.entries.push(entry)
  return entry
}

/** Handles one user transcript submission for the session already bound to the socket. */
async function handleUserMessage(
  state: SharedServerState,
  agentRuntime: AgentRuntime,
  socket: ServerWebSocket<SessionSocketData>,
  message: UserMessageRequest,
): Promise<void> {
  const activeSessionId = socket.data.sessionId

  if (!activeSessionId) {
    sendServerMessage(socket, createSessionErrorMessage('The first session message must be connect.'))
    return
  }

  if (message.sessionId !== activeSessionId) {
    sendServerMessage(
      socket,
      createSessionErrorMessage('The submitted session id did not match the active connection.'),
    )
    return
  }

  const session = state.getOrCreateSession(activeSessionId)
  const userEntry = appendEntry(session, 'user', message.text)

  broadcastToSession(session, createConversationEntryMessage(userEntry))

  try {
    const result = await agentRuntime.runTurn({
      entries: [...session.entries],
      sessionId: activeSessionId,
      userText: message.text,
    })
    const assistantEntry = appendEntry(session, 'assistant', result.assistantText)
    broadcastToSession(session, createConversationEntryMessage(assistantEntry))
  } catch (error) {
    sendServerMessage(
      socket,
      createSessionErrorMessage(
        error instanceof Error ? error.message : 'The assistant could not complete the turn.',
      ),
    )
  }
}

/** Handles one websocket payload against the shared server-owned session state. */
async function handleSocketMessage(
  state: SharedServerState,
  agentRuntime: AgentRuntime,
  socket: ServerWebSocket<SessionSocketData>,
  payload: string,
): Promise<void> {
  const message = parseClientSessionMessage(payload)

  if (!message) {
    sendServerMessage(
      socket,
      createSessionErrorMessage('The session server received an invalid message.'),
    )
    return
  }

  if (!socket.data.sessionId) {
    if (message.type !== 'connect') {
      sendServerMessage(socket, createSessionErrorMessage('The first session message must be connect.'))
      return
    }

    handleConnectMessage(state, socket, message)
    return
  }

  if (message.type === 'connect') {
    return
  }

  await handleUserMessage(state, agentRuntime, socket, message)
}

/** Starts the Bun session server with health and websocket endpoints. */
export function startSessionServer(options: StartSessionServerOptions = {}): SessionServerHandle {
  const agentRuntime = options.agentRuntime ?? createAgentRuntime()
  const port = options.port ?? getServerPort()
  const state = new SharedServerState()
  const server = Bun.serve<SessionSocketData>({
    port,
    fetch(request, server) {
      const url = new URL(request.url)

      if (url.pathname === '/health') {
        return new Response('ok')
      }

      if (url.pathname === '/ws') {
        const wasUpgraded = server.upgrade(request, {
          data: {
            sessionId: null,
          },
        })

        if (wasUpgraded) {
          return
        }

        return new Response('The websocket upgrade failed.', { status: 400 })
      }

      return new Response('Not found.', { status: 404 })
    },
    websocket: {
      message(socket, message) {
        void handleSocketMessage(
          state,
          agentRuntime,
          socket,
          typeof message === 'string' ? message : String(message),
        ).catch((error) => {
          sendServerMessage(
            socket,
            createSessionErrorMessage(
              error instanceof Error
                ? error.message
                : 'The session server encountered an unexpected error.',
            ),
          )
        })
      },
      close(socket) {
        removeSocketFromSession(state, socket)
      },
    },
  })

  return {
    server,
    async stop(): Promise<void> {
      server.stop(true)
      await agentRuntime.destroy?.()
    },
  }
}
