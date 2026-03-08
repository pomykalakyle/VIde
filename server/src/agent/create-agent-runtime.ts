import { getAgentRuntimeMode, getFakeAssistantReply } from '../config'
import type { AgentRuntime } from './agent-runtime'
import { createStaticAgentRuntime } from './fake-agent-runtime'
import { createOpenCodeAgentRuntime } from './opencode-agent-runtime'

/** Creates the default agent runtime for the current Bun backend process. */
export function createAgentRuntime(): AgentRuntime {
  if (getAgentRuntimeMode() === 'fake') {
    return createStaticAgentRuntime({
      assistantText: getFakeAssistantReply(),
    })
  }

  return createOpenCodeAgentRuntime()
}
