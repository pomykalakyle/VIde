import type { AgentRunTurnInput, AgentRunTurnResult, AgentRuntime } from './agent-runtime'

/** Represents one deterministic fake runtime used by tests and local validation. */
export interface StaticAgentRuntimeOptions {
  assistantText: string | ((input: AgentRunTurnInput) => string)
}

/** Represents one fake streaming runtime used by websocket and UI tests. */
export interface StreamingAgentRuntimeOptions {
  assistantTextSnapshots: string[]
  delayMs?: number
  finalAssistantText?: string
}

/** Returns one promise that resolves after the provided delay. */
function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

/** Creates one runtime that always returns a stable assistant reply. */
export function createStaticAgentRuntime(options: StaticAgentRuntimeOptions): AgentRuntime {
  return {
    async runTurn(input: AgentRunTurnInput): Promise<AgentRunTurnResult> {
      const assistantText =
        typeof options.assistantText === 'function'
          ? options.assistantText(input)
          : options.assistantText

      await input.onAssistantTextUpdate?.(assistantText)

      return {
        assistantText,
      }
    },
  }
}

/** Creates one runtime that emits partial assistant snapshots before returning its final reply. */
export function createStreamingAgentRuntime(options: StreamingAgentRuntimeOptions): AgentRuntime {
  return {
    async runTurn(input: AgentRunTurnInput): Promise<AgentRunTurnResult> {
      for (const assistantTextSnapshot of options.assistantTextSnapshots) {
        await input.onAssistantTextUpdate?.(assistantTextSnapshot)

        if (options.delayMs && options.delayMs > 0) {
          await wait(options.delayMs)
        }
      }

      return {
        assistantText:
          options.finalAssistantText ??
          options.assistantTextSnapshots.at(-1) ??
          'Fake streaming assistant reply.',
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
