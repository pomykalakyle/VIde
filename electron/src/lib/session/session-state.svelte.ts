import type { ConversationEntry } from '../types/conversation'
import type { SessionConnectionStatus, ServerSessionMessage } from '../types/session'
import {
  createSessionClient,
  type SessionClient,
  type SessionClientEvent,
  type SessionClientOptions,
} from './session-client'

/** Represents the renderer-owned reactive session state for the current app session. */
export class SessionState {
  entries = $state.raw<ConversationEntry[]>([])
  connectionStatus = $state<SessionConnectionStatus>('disconnected')
  error = $state('')
  isResponding = $state(false)
  sessionId: string

  #client: SessionClient
  #unsubscribe: (() => void) | null = null

  /** Creates the reactive session state and attaches it to one session client. */
  constructor(options: SessionClientOptions = {}) {
    this.#client = createSessionClient(options)
    this.sessionId = this.#client.sessionId
    this.#unsubscribe = this.#client.subscribe((event) => {
      this.#handleClientEvent(event)
    })
  }

  /** Opens the underlying renderer session client. */
  async connect(): Promise<void> {
    this.error = ''

    try {
      await this.#client.connect()
    } catch (error) {
      this.error = error instanceof Error ? error.message : 'The session server could not be reached.'
    }
  }

  /** Closes the underlying renderer session client. */
  disconnect(): void {
    this.#client.disconnect()
  }

  /** Submits one finalized user transcript to the server-owned session. */
  async submitUserMessage(text: string): Promise<boolean> {
    const trimmedText = text.trim()

    if (!trimmedText) {
      return false
    }

    this.error = ''

    try {
      this.isResponding = true
      this.#client.submitUserMessage(trimmedText)
      return true
    } catch (error) {
      this.isResponding = false
      this.error = error instanceof Error ? error.message : 'The session message could not be sent.'
      return false
    }
  }

  /** Tears down the state subscription and closes the underlying client. */
  destroy(): void {
    this.#unsubscribe?.()
    this.#unsubscribe = null
    this.disconnect()
  }

  /** Applies one session-client event to the local reactive renderer state. */
  #handleClientEvent(event: SessionClientEvent): void {
    if (event.type === 'status') {
      this.connectionStatus = event.status

      if (event.status !== 'connected') {
        this.isResponding = false
      }

      return
    }

    if (event.type === 'error') {
      this.error = event.message
      this.isResponding = false
      return
    }

    this.#applyServerMessage(event.message)
  }

  /** Applies one server session message to the local renderer session state. */
  #applyServerMessage(message: ServerSessionMessage): void {
    if (message.type === 'session_snapshot') {
      this.entries = [...message.entries]
      this.isResponding = false
      this.error = ''
      return
    }

    if (message.type === 'conversation_entry') {
      this.entries = [...this.entries, message.entry]
      this.error = ''
      this.isResponding = message.entry.role === 'user'
      return
    }

    this.error = message.message
    this.isResponding = false
  }
}

/** Creates the app-level reactive session state for the current renderer. */
export function createSessionState(options: SessionClientOptions = {}): SessionState {
  return new SessionState(options)
}

/** Represents the default renderer session state shared across the app. */
export const sessionState = createSessionState()
