import type { ConversationEntry } from './conversation'

/** Represents the current connection state for the renderer session client. */
export type SessionConnectionStatus = 'disconnected' | 'connecting' | 'connected'

/** Represents the first client message that joins a server-owned session. */
export interface SessionConnectMessage {
  type: 'connect'
  sessionId: string
}

/** Represents a finalized user transcript submitted to the backend. */
export interface UserMessageRequest {
  type: 'user_message'
  sessionId: string
  text: string
}

/** Represents any client message sent to the Rust session server. */
export type ClientSessionMessage = SessionConnectMessage | UserMessageRequest

/** Represents the initial server snapshot used to hydrate renderer state. */
export interface SessionSnapshotMessage {
  type: 'session_snapshot'
  sessionId: string
  entries: ConversationEntry[]
}

/** Represents one append-only transcript event emitted by the server. */
export interface ConversationEntryMessage {
  type: 'conversation_entry'
  entry: ConversationEntry
}

/** Represents a server-side session error surfaced to the renderer. */
export interface SessionErrorMessage {
  type: 'session_error'
  message: string
}

/** Represents any server message emitted by the Rust session server. */
export type ServerSessionMessage =
  | SessionSnapshotMessage
  | ConversationEntryMessage
  | SessionErrorMessage
