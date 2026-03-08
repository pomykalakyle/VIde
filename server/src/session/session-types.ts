/** Represents one transcript role stored inside the Bun session server. */
export type ConversationRole = 'user' | 'assistant'

/** Represents one transcript entry stored inside a server-owned session. */
export interface ConversationEntry {
  id: string
  role: ConversationRole
  content: string
}

/** Represents the first client message that joins a server-owned session. */
export interface SessionConnectMessage {
  type: 'connect'
  sessionId: string
}

/** Represents one finalized user transcript sent from the client to the server. */
export interface UserMessageRequest {
  type: 'user_message'
  sessionId: string
  text: string
}

/** Represents any client message accepted by the Bun session server. */
export type ClientSessionMessage = SessionConnectMessage | UserMessageRequest

/** Represents the initial server snapshot sent after a client joins a session. */
export interface SessionSnapshotMessage {
  type: 'session_snapshot'
  sessionId: string
  entries: ConversationEntry[]
}

/** Represents one append-only transcript event emitted by the Bun server. */
export interface ConversationEntryMessage {
  type: 'conversation_entry'
  entry: ConversationEntry
}

/** Represents one renderer-safe session error emitted by the Bun server. */
export interface SessionErrorMessage {
  type: 'session_error'
  message: string
}

/** Represents any server message emitted by the Bun session server. */
export type ServerSessionMessage =
  | SessionSnapshotMessage
  | ConversationEntryMessage
  | SessionErrorMessage

/** Represents one websocket connection tracked by the Bun session server. */
export interface SessionSocketData {
  sessionId: string | null
}
