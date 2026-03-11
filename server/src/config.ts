import { dirname, resolve } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

import type { Config as OpenCodeConfig } from '@opencode-ai/sdk'

const sourceDirectory = dirname(fileURLToPath(import.meta.url))
const serverDirectory = resolve(sourceDirectory, '..')
const opencodeRuntimeDockerDirectory = resolve(serverDirectory, 'docker', 'opencode-runtime')

/** Represents the model selection VIde sends to OpenCode for agent turns. */
export interface OpenCodeModelSelection {
  providerID: string
  modelID: string
}

/** Represents the default local secret-storage mode for persisted OpenAI credentials. */
export type DefaultSecretStorageMode = 'plaintext' | 'encrypted'

/** Represents the runtime mode that should back assistant turns. */
export type AgentRuntimeMode = 'fake' | 'opencode'

/** Represents the OpenCode prompt settings threaded through runtime adapters. */
export interface OpenCodeRuntimeOptions {
  agentName: string
  model: string
  systemPrompt: string
}

export const defaultServerPort = 8787
export const defaultConfigDirectory = resolve(homedir(), '.config', 'vide')
export const defaultSessionContainerDockerCommand = 'docker'
export const defaultSessionContainerImage = 'vide-opencode-runtime:local'
export const defaultSessionContainerDockerfilePath = resolve(opencodeRuntimeDockerDirectory, 'Dockerfile')
export const defaultSessionContainerBuildContext = opencodeRuntimeDockerDirectory
export const defaultSessionContainerAutoBuildImage = true
export const defaultSessionContainerEntrypoint = 'sh'
export const defaultSessionContainerCommand =
  'OPENCODE_ENABLE_EXA=1 opencode serve --hostname 0.0.0.0 --port 4096'
export const defaultSessionContainerPort = 4096
export const defaultSessionContainerHealthPath = '/global/health'
export const defaultSessionContainerStartupTimeoutMs = 20_000
export const defaultSessionContainerHealthPollIntervalMs = 250
export const defaultWorkspaceDirectory = resolve(serverDirectory, '..')
export const defaultSessionContainerWorkspaceMountTarget = '/workspace'
export const defaultSessionContainerMountWorkspace = false
export const defaultSecretStorageMode: DefaultSecretStorageMode = 'encrypted'
export const defaultAgentRuntimeMode: AgentRuntimeMode = 'opencode'
export const defaultFakeAssistantReply = 'Fake OpenCode assistant reply.'
export const defaultOpenCodeModel = 'openai/gpt-5'
export const defaultOpenCodeAgentName = 'build'
export const defaultOpenCodeSystemPrompt =
  'You are VIde, a concise coding assistant running inside a voice-first IDE. ' +
  'Answer the user helpfully and tersely. Do not mention internal implementation details unless asked.'

/** Returns the resolved OpenCode prompt settings used by runtime adapters. */
export function createOpenCodeRuntimeOptions(
  options: Partial<OpenCodeRuntimeOptions> = {},
): OpenCodeRuntimeOptions {
  return {
    agentName: options.agentName ?? defaultOpenCodeAgentName,
    model: options.model ?? defaultOpenCodeModel,
    systemPrompt: options.systemPrompt ?? defaultOpenCodeSystemPrompt,
  }
}

/** Returns the provider and model that OpenCode should use for assistant turns. */
export function getOpenCodeModelSelection(
  configuredModel: string = defaultOpenCodeModel,
): OpenCodeModelSelection {
  const [providerID, ...modelParts] = configuredModel.split('/')

  if (!providerID || modelParts.length === 0) {
    return {
      providerID: 'openai',
      modelID: 'gpt-5',
    }
  }

  return {
    providerID,
    modelID: modelParts.join('/'),
  }
}

/** Returns the inline OpenCode config VIde should use for embedded runtime startup. */
export function createOpenCodeConfig(
  options: Partial<OpenCodeRuntimeOptions> = {},
): OpenCodeConfig {
  const openCodeOptions = createOpenCodeRuntimeOptions(options)
  const { providerID, modelID } = getOpenCodeModelSelection(openCodeOptions.model)

  return {
    autoupdate: false,
    model: `${providerID}/${modelID}`,
    provider: {
      openai: {
        options: {
          apiKey: '{env:OPENAI_API_KEY}',
        },
      },
    },
    share: 'disabled',
  }
}
