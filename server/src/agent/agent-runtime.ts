import type { ConversationEntry } from '../session/session-types'

/** Represents one callback that receives the latest assistant text during streaming. */
export type AgentAssistantTextUpdate = (assistantText: string) => Promise<void> | void

/** Represents the canonical backend input for one agent turn. */
export interface AgentRunTurnInput {
  entries: ConversationEntry[]
  onAssistantTextUpdate?: AgentAssistantTextUpdate
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
