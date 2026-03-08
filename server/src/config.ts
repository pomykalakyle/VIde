import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { Config as OpenCodeConfig } from '@opencode-ai/sdk'

const sourceDirectory = dirname(fileURLToPath(import.meta.url))
const serverDirectory = resolve(sourceDirectory, '..')
const workspaceDirectory = resolve(serverDirectory, '..')

/** Represents the model selection VIde sends to OpenCode for agent turns. */
export interface OpenCodeModelSelection {
  providerID: string
  modelID: string
}

/** Returns the local TCP port configured for the Bun session server. */
export function getServerPort(): number {
  const port = Number(process.env.VIDE_SERVER_PORT ?? '8787')
  return Number.isInteger(port) && port > 0 ? port : 8787
}

/** Returns the repository root that agent sessions should treat as the workspace. */
export function getWorkspaceDirectory(): string {
  return process.env.VIDE_WORKSPACE_DIR ?? workspaceDirectory
}

/** Returns the runtime mode that should back assistant turns. */
export function getAgentRuntimeMode(): 'fake' | 'opencode' {
  return process.env.VIDE_AGENT_RUNTIME_MODE === 'fake' ? 'fake' : 'opencode'
}

/** Returns the deterministic assistant reply used by fake runtime tests. */
export function getFakeAssistantReply(): string {
  return process.env.VIDE_FAKE_ASSISTANT_REPLY ?? 'Fake OpenCode assistant reply.'
}

/** Returns the provider and model that OpenCode should use for assistant turns. */
export function getOpenCodeModelSelection(): OpenCodeModelSelection {
  const configuredModel = process.env.VIDE_OPENCODE_MODEL ?? 'openai/gpt-5'
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

/** Returns the OpenCode agent name that should process assistant turns. */
export function getOpenCodeAgentName(): string {
  return process.env.VIDE_OPENCODE_AGENT ?? 'build'
}

/** Returns the system prompt used for the first text-only OpenCode integration. */
export function getOpenCodeSystemPrompt(): string {
  return (
    'You are VIde, a concise coding assistant running inside a voice-first IDE. ' +
    'Answer the user helpfully and tersely. Do not mention internal implementation details unless asked.'
  )
}

/** Returns the built-in OpenCode tools that should stay disabled for the first milestone. */
export function getDisabledOpenCodeTools(): Record<string, boolean> {
  return {
    bash: false,
    edit: false,
    glob: false,
    grep: false,
    list: false,
    lsp: false,
    patch: false,
    question: false,
    read: false,
    skill: false,
    todoread: false,
    todowrite: false,
    webfetch: false,
    write: false,
  }
}

/** Returns the inline OpenCode config VIde should use for embedded runtime startup. */
export function getOpenCodeConfig(): OpenCodeConfig {
  const { providerID, modelID } = getOpenCodeModelSelection()
  const fullModelId = `${providerID}/${modelID}`

  return {
    autoupdate: false,
    model: fullModelId,
    provider: {
      anthropic: {
        options: {
          apiKey: '{env:ANTHROPIC_API_KEY}',
        },
      },
      openai: {
        options: {
          apiKey: '{env:OPENAI_API_KEY}',
        },
      },
      openrouter: {
        options: {
          apiKey: '{env:OPENROUTER_API_KEY}',
        },
      },
    },
    share: 'disabled',
  }
}
