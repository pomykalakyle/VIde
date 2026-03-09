import { getAgentRuntimeMode, getFakeAssistantReply } from '../config'
import type { SessionContainerManager } from '../container/session-container'
import type { AgentRuntime } from './agent-runtime'
import { createStaticAgentRuntime } from './fake-agent-runtime'
import { createOpenCodeSdkClientAdapter } from './opencode-sdk-client'

/** Represents the optional dependencies for the default agent factory. */
export interface CreateAgentRuntimeOptions {
  sessionContainerManager?: SessionContainerManager
}

/** Creates the default agent runtime for the current Bun backend process. */
export function createAgentRuntime(options: CreateAgentRuntimeOptions = {}): AgentRuntime {
  if (getAgentRuntimeMode() === 'fake') {
    return createStaticAgentRuntime({
      assistantText: getFakeAssistantReply(),
    })
  }

  if (!options.sessionContainerManager) {
    throw new Error('The OpenCode SDK client adapter requires a session container manager.')
  }

  return createOpenCodeSdkClientAdapter(options.sessionContainerManager)
}
