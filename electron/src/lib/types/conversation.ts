/** Represents a single transcript entry in the conversation pane. */
export type ConversationEntry = UserConversationEntry | AgentConversationEntry

/** Represents a transcript entry authored by the user. */
export interface UserConversationEntry {
  id: string
  role: 'user'
  content: string
}

/** Represents a transcript entry authored by the agent. */
export interface AgentConversationEntry {
  id: string
  role: 'assistant'
  content: string
}
