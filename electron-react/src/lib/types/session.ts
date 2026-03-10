/** Represents one transcript role shown by the chat session UI. */
export type ConversationRole = 'user' | 'assistant'

/** Represents one local rendering state for a conversation entry. */
export type ConversationEntryStatus = 'complete' | 'pending' | 'error'

/** Represents one transcript entry exchanged by the chat session protocol. */
export interface ConversationEntry {
  id: string
  role: ConversationRole
  content: string
}

/** Represents one transcript entry rendered by the chat session UI. */
export interface RenderedConversationEntry extends ConversationEntry {
  status: ConversationEntryStatus
}

/** Represents the first client message sent after the socket opens. */
export interface SessionConnectMessage {
  type: 'connect'
  sessionId: string
}

/** Represents one text message sent from the renderer to the backend. */
export interface UserMessageRequest {
  type: 'user_message'
  sessionId: string
  text: string
}

/** Represents any client message accepted by the chat session socket. */
export type ClientSessionMessage = SessionConnectMessage | UserMessageRequest

/** Represents one transcript entry pushed from the backend to the renderer. */
export interface ConversationEntryMessage {
  type: 'conversation_entry'
  entry: ConversationEntry
}

/** Represents one partial transcript snapshot pushed while an assistant reply is streaming. */
export interface ConversationEntryDeltaMessage {
  type: 'conversation_entry_delta'
  entry: ConversationEntry
}

/** Represents one renderer-safe session error pushed from the backend. */
export interface SessionErrorMessage {
  type: 'session_error'
  message: string
}

/** Represents any server message emitted by the chat session socket. */
export type ServerSessionMessage =
  | ConversationEntryDeltaMessage
  | ConversationEntryMessage
  | SessionErrorMessage
