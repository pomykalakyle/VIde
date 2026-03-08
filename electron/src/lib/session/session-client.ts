import type {
  ClientSessionMessage,
  ServerSessionMessage,
  SessionConnectionStatus,
  UserMessageRequest,
} from '../types/session'

/** Represents a connection status event emitted by the renderer session client. */
export interface SessionClientStatusEvent {
  type: 'status'
  status: SessionConnectionStatus
}

/** Represents a server message event emitted by the renderer session client. */
export interface SessionClientMessageEvent {
  type: 'message'
  message: ServerSessionMessage
}

/** Represents a renderer-safe connection error emitted by the session client. */
export interface SessionClientErrorEvent {
  type: 'error'
  message: string
}

/** Represents any event emitted by the renderer session client. */
export type SessionClientEvent =
  | SessionClientStatusEvent
  | SessionClientMessageEvent
  | SessionClientErrorEvent

/** Represents the configurable inputs for creating a renderer session client. */
export interface SessionClientOptions {
  sessionId?: string
  url?: string
  webSocketFactory?: (url: string) => WebSocket
}

/** Represents a subscriber that reacts to session-client status and message events. */
export type SessionClientListener = (event: SessionClientEvent) => void

/** Returns the default local WebSocket endpoint for the session server. */
function getDefaultSessionServerUrl(): string {
  return 'ws://127.0.0.1:8787/ws'
}

/** Converts an unknown error into a short renderer-safe connection error message. */
function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'The session connection failed.'
}

/** Parses one incoming WebSocket payload into a server session message. */
function parseSessionMessage(payload: string): ServerSessionMessage {
  return JSON.parse(payload) as ServerSessionMessage
}

/** Represents the renderer-owned WebSocket client for one server-backed session. */
export class SessionClient {
  readonly sessionId: string

  #listeners = new Set<SessionClientListener>()
  #socket: WebSocket | null = null
  #status: SessionConnectionStatus = 'disconnected'
  #url: string
  #webSocketFactory: (url: string) => WebSocket

  /** Creates the renderer session client with its target session and endpoint. */
  constructor(options: SessionClientOptions = {}) {
    this.sessionId = options.sessionId ?? 'local-dev'
    this.#url = options.url ?? getDefaultSessionServerUrl()
    this.#webSocketFactory = options.webSocketFactory ?? ((url) => new WebSocket(url))
  }

  /** Returns the latest renderer-visible connection status. */
  get status(): SessionConnectionStatus {
    return this.#status
  }

  /** Registers one listener for future session-client events. */
  subscribe(listener: SessionClientListener): () => void {
    this.#listeners.add(listener)

    return () => {
      this.#listeners.delete(listener)
    }
  }

  /** Opens the WebSocket and joins the configured server-owned session. */
  async connect(): Promise<void> {
    if (this.#socket && this.#socket.readyState === WebSocket.OPEN) {
      return
    }

    if (this.#socket && this.#socket.readyState === WebSocket.CONNECTING) {
      return
    }

    this.#setStatus('connecting')

    await new Promise<void>((resolve, reject) => {
      const socket = this.#webSocketFactory(this.#url)
      this.#socket = socket
      this.#attachSocketListeners(socket)

      const handleOpen = () => {
        socket.removeEventListener('error', handleError)
        socket.removeEventListener('close', handleCloseBeforeOpen)
        this.#setStatus('connected')
        this.#send({
          type: 'connect',
          sessionId: this.sessionId,
        })
        resolve()
      }

      const handleError = () => {
        socket.removeEventListener('open', handleOpen)
        socket.removeEventListener('close', handleCloseBeforeOpen)
        this.#socket = null
        this.#setStatus('disconnected')
        reject(new Error('The session server could not be reached.'))
      }

      const handleCloseBeforeOpen = () => {
        socket.removeEventListener('open', handleOpen)
        socket.removeEventListener('error', handleError)
        this.#socket = null
        this.#setStatus('disconnected')
        reject(new Error('The session server closed the connection before it opened.'))
      }

      socket.addEventListener('open', handleOpen, { once: true })
      socket.addEventListener('error', handleError, { once: true })
      socket.addEventListener('close', handleCloseBeforeOpen, { once: true })
    }).catch((error) => {
      this.#emit({
        type: 'error',
        message: toErrorMessage(error),
      })
      throw error
    })
  }

  /** Closes the WebSocket and leaves the configured session. */
  disconnect(): void {
    if (!this.#socket) {
      this.#setStatus('disconnected')
      return
    }

    const socket = this.#socket
    this.#socket = null
    socket.close(1000, 'Renderer disconnected.')
    this.#setStatus('disconnected')
  }

  /** Sends one finalized user transcript to the session server. */
  submitUserMessage(text: string): void {
    const trimmedText = text.trim()

    if (!trimmedText) {
      throw new Error('A session message cannot be empty.')
    }

    this.#send({
      type: 'user_message',
      sessionId: this.sessionId,
      text: trimmedText,
    } satisfies UserMessageRequest)
  }

  /** Attaches the long-lived socket listeners for messages, errors, and closes. */
  #attachSocketListeners(socket: WebSocket): void {
    socket.addEventListener('message', (event) => {
      try {
        this.#emit({
          type: 'message',
          message: parseSessionMessage(String(event.data)),
        })
      } catch {
        this.#emit({
          type: 'error',
          message: 'The session server sent an invalid message.',
        })
      }
    })

    socket.addEventListener('error', () => {
      if (this.#socket !== socket) {
        return
      }

      this.#emit({
        type: 'error',
        message: 'The session connection encountered an error.',
      })
    })

    socket.addEventListener('close', () => {
      if (this.#socket !== socket) {
        return
      }

      this.#socket = null
      this.#setStatus('disconnected')
    })
  }

  /** Sends one JSON-encoded client message across the active WebSocket. */
  #send(message: ClientSessionMessage): void {
    if (!this.#socket || this.#socket.readyState !== WebSocket.OPEN) {
      throw new Error('The session server is not connected.')
    }

    this.#socket.send(JSON.stringify(message))
  }

  /** Updates the current connection status and emits it to subscribers. */
  #setStatus(status: SessionConnectionStatus): void {
    if (this.#status === status) {
      return
    }

    this.#status = status
    this.#emit({
      type: 'status',
      status,
    })
  }

  /** Emits one session-client event to every current subscriber. */
  #emit(event: SessionClientEvent): void {
    for (const listener of this.#listeners) {
      listener(event)
    }
  }
}

/** Creates the renderer-owned WebSocket client for the default session. */
export function createSessionClient(options: SessionClientOptions = {}): SessionClient {
  return new SessionClient(options)
}
