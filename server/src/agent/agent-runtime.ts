import type { ConversationEntry } from '../session/session-types'

/** Represents the canonical backend input for one agent turn. */
export interface AgentRunTurnInput {
  entries: ConversationEntry[]
  sessionId: string
  userText: string
}

/** Represents the final assistant text returned by one agent turn. */
export interface AgentRunTurnResult {
  assistantText: string
}

/** Represents the minimal runtime contract the Bun backend depends on. */
export interface AgentRuntime {
  runTurn(input: AgentRunTurnInput): Promise<AgentRunTurnResult>
  destroy?(): Promise<void> | void
}
