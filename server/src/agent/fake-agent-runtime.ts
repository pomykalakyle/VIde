import type { AgentRunTurnInput, AgentRunTurnResult, AgentRuntime } from './agent-runtime'

/** Represents one deterministic fake runtime used by tests and local validation. */
export interface StaticAgentRuntimeOptions {
  assistantText: string | ((input: AgentRunTurnInput) => string)
}

/** Creates one runtime that always returns a stable assistant reply. */
export function createStaticAgentRuntime(options: StaticAgentRuntimeOptions): AgentRuntime {
  return {
    async runTurn(input: AgentRunTurnInput): Promise<AgentRunTurnResult> {
      return {
        assistantText:
          typeof options.assistantText === 'function'
            ? options.assistantText(input)
            : options.assistantText,
      }
    },
  }
}

/** Creates one runtime that always throws the provided backend-safe error. */
export function createThrowingAgentRuntime(message: string): AgentRuntime {
  return {
    async runTurn(): Promise<AgentRunTurnResult> {
      throw new Error(message)
    },
  }
}
