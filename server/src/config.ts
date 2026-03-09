import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { Config as OpenCodeConfig } from '@opencode-ai/sdk'

const sourceDirectory = dirname(fileURLToPath(import.meta.url))
const serverDirectory = resolve(sourceDirectory, '..')
const opencodeRuntimeDockerDirectory = resolve(serverDirectory, 'docker', 'opencode-runtime')
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

/** Returns the Docker CLI command used to manage session containers. */
export function getSessionContainerDockerCommand(): string {
  return process.env.VIDE_SESSION_CONTAINER_DOCKER_COMMAND ?? 'docker'
}

/** Returns the Docker image VIde should boot for each session container. */
export function getSessionContainerImage(): string {
  return process.env.VIDE_SESSION_CONTAINER_IMAGE ?? 'vide-opencode-runtime:local'
}

/** Returns the Dockerfile path used when building the default session container image. */
export function getSessionContainerDockerfilePath(): string {
  return process.env.VIDE_SESSION_CONTAINER_DOCKERFILE ?? resolve(opencodeRuntimeDockerDirectory, 'Dockerfile')
}

/** Returns the Docker build context used for the default session container image. */
export function getSessionContainerBuildContext(): string {
  return process.env.VIDE_SESSION_CONTAINER_BUILD_CONTEXT ?? opencodeRuntimeDockerDirectory
}

/** Returns whether VIde should build the default session container image automatically. */
export function getSessionContainerAutoBuildImage(): boolean {
  return process.env.VIDE_SESSION_CONTAINER_AUTO_BUILD !== 'false'
}

/** Returns the entrypoint VIde should use when booting the session container. */
export function getSessionContainerEntrypoint(): string {
  return process.env.VIDE_SESSION_CONTAINER_ENTRYPOINT ?? 'sh'
}

/** Returns the shell command the session container should run on startup. */
export function getSessionContainerCommand(): string {
  return (
    process.env.VIDE_SESSION_CONTAINER_COMMAND ?? 'opencode serve --hostname 0.0.0.0 --port 4096'
  )
}

/** Returns the TCP port the session container publishes for OpenCode. */
export function getSessionContainerPort(): number {
  const port = Number(process.env.VIDE_SESSION_CONTAINER_PORT ?? '4096')
  return Number.isInteger(port) && port > 0 ? port : 4096
}

/** Returns the HTTP health path VIde probes inside the session container. */
export function getSessionContainerHealthPath(): string {
  const configuredPath = process.env.VIDE_SESSION_CONTAINER_HEALTH_PATH ?? '/global/health'
  return configuredPath.startsWith('/') ? configuredPath : `/${configuredPath}`
}

/** Returns the startup timeout used when waiting for a session container. */
export function getSessionContainerStartupTimeoutMs(): number {
  const timeoutMs = Number(process.env.VIDE_SESSION_CONTAINER_STARTUP_TIMEOUT_MS ?? '20000')
  return Number.isInteger(timeoutMs) && timeoutMs > 0 ? timeoutMs : 20000
}

/** Returns the polling interval used while waiting for a session container. */
export function getSessionContainerHealthPollIntervalMs(): number {
  const intervalMs = Number(process.env.VIDE_SESSION_CONTAINER_HEALTH_POLL_INTERVAL_MS ?? '250')
  return Number.isInteger(intervalMs) && intervalMs > 0 ? intervalMs : 250
}

/** Returns the repository root that agent sessions should treat as the workspace. */
export function getWorkspaceDirectory(): string {
  return process.env.VIDE_WORKSPACE_DIR ?? workspaceDirectory
}

/** Returns the mounted workspace path inside the session container. */
export function getSessionContainerWorkspaceMountTarget(): string {
  return process.env.VIDE_SESSION_CONTAINER_WORKSPACE_PATH ?? '/workspace'
}

/** Returns whether VIde should bind-mount the host workspace into the session container. */
export function getSessionContainerMountWorkspace(): boolean {
  return process.env.VIDE_SESSION_CONTAINER_MOUNT_WORKSPACE === 'true'
}

/** Returns the environment variable names forwarded into the session container. */
export function getSessionContainerForwardedEnvNames(): string[] {
  const configuredNames = process.env.VIDE_SESSION_CONTAINER_FORWARD_ENV

  if (!configuredNames) {
    return ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY']
  }

  return configuredNames
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name.length > 0)
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
