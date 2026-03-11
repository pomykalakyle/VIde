import {
  createOpenCodeRuntimeOptions,
  defaultAgentRuntimeMode,
  defaultFakeAssistantReply,
  type AgentRuntimeMode,
  type OpenCodeRuntimeOptions,
} from '../config'
import type { SessionRuntimeManager } from '../container/session-container'
import type { AgentRuntime } from './agent-runtime'
import { createStaticAgentRuntime } from './fake-agent-runtime'
import { createOpenCodeSdkClientAdapter } from './opencode-sdk-client'

/** Represents the optional dependencies for the default agent factory. */
export interface CreateAgentRuntimeOptions {
  fakeAssistantReply?: string
  openCode?: Partial<OpenCodeRuntimeOptions>
  runtimeMode?: AgentRuntimeMode
  sessionRuntimeManager?: SessionRuntimeManager
}

/** Creates the default agent runtime for the current Bun backend process. */
export function createAgentRuntime(options: CreateAgentRuntimeOptions = {}): AgentRuntime {
  const runtimeMode = options.runtimeMode ?? defaultAgentRuntimeMode

  if (runtimeMode === 'fake') {
    return createStaticAgentRuntime({
      assistantText: options.fakeAssistantReply ?? defaultFakeAssistantReply,
    })
  }

  if (!options.sessionRuntimeManager) {
    throw new Error('The OpenCode SDK client adapter requires a session runtime manager.')
  }

  return createOpenCodeSdkClientAdapter(
    options.sessionRuntimeManager,
    createOpenCodeRuntimeOptions(options.openCode),
  )
}
