import { resolve } from 'node:path'

import type { WorkspaceRecord } from '../workspace/workspace-store'
import {
  createDockerSessionRuntimeManager,
  createUnsafeHostSessionRuntimeManager,
  type DockerSessionRuntimeManagerOptions,
  type SessionRuntimeManager,
  type SessionRuntimeSnapshot,
  type UnsafeHostSessionRuntimeManagerOptions,
} from './session-container'

/** Represents one workspace-aware runtime manager that can reattach to different folders. */
export interface WorkspaceSessionRuntimeManager extends SessionRuntimeManager {
  attachWorkspace(workspace: WorkspaceRecord): Promise<void>
  detachWorkspace(): Promise<void>
  getWorkspaceDirectory(): string | null
}

/** Represents the options used to create one workspace-aware runtime manager. */
export interface CreateWorkspaceSessionRuntimeManagerOptions
  extends DockerSessionRuntimeManagerOptions {
  managerFactory?: (workspace: WorkspaceRecord) => SessionRuntimeManager
  unsafeHost?: UnsafeHostSessionRuntimeManagerOptions
}

/** Represents one compatibility alias for existing container terminology. */
export type WorkspaceSessionContainerManager = WorkspaceSessionRuntimeManager

/** Represents one compatibility alias for existing container terminology. */
export type CreateWorkspaceSessionContainerManagerOptions =
  CreateWorkspaceSessionRuntimeManagerOptions

/** Returns one stopped runtime snapshot used before any workspace is attached. */
function createDetachedSnapshot(
  _options: CreateWorkspaceSessionRuntimeManagerOptions,
): SessionRuntimeSnapshot {
  return {
    baseUrl: null,
    dockerContainer: null,
    error: '',
    executionMode: null,
    openCodeError: '',
    openCodeStatus: 'stopped',
    openCodeVersion: null,
    startedAt: null,
    status: 'stopped',
  }
}

/** Creates one workspace-aware session-runtime manager for the Bun backend. */
export function createWorkspaceSessionRuntimeManager(
  options: CreateWorkspaceSessionRuntimeManagerOptions = {},
): WorkspaceSessionRuntimeManager {
  const managerFactory =
    options.managerFactory ??
    ((workspace: WorkspaceRecord) =>
      workspace.executionMode === 'unsafe-host'
        ? createUnsafeHostSessionRuntimeManager(options.unsafeHost)
        : createDockerSessionRuntimeManager({
            ...options,
            mountWorkspace: options.mountWorkspace ?? true,
            workspaceDirectory: workspace.hostPath,
          }))
  let currentWorkspace: WorkspaceRecord | null = null
  let currentManager: SessionRuntimeManager | null = null
  const detachedSnapshot = createDetachedSnapshot(options)

  /** Returns the latest session-runtime snapshot for the active workspace. */
  function getSnapshot(): SessionRuntimeSnapshot {
    if (!currentManager) {
      return { ...detachedSnapshot }
    }

    return currentManager.getSnapshot()
  }

  /** Returns the currently attached host workspace directory when it exists. */
  function getWorkspaceDirectory(): string | null {
    return currentWorkspace?.hostPath ?? null
  }

  /** Starts the current workspace runtime when one workspace is attached. */
  async function start(): Promise<void> {
    if (!currentManager) {
      return
    }

    await currentManager.start()
  }

  /** Stops the current workspace runtime when one workspace is attached. */
  async function stop(): Promise<void> {
    if (!currentManager) {
      return
    }

    await currentManager.stop()
  }

  /** Replaces the current runtime with one attached to the provided saved workspace. */
  async function attachWorkspace(workspace: WorkspaceRecord): Promise<void> {
    const nextWorkspace = {
      ...workspace,
      hostPath: resolve(workspace.hostPath),
    }

    if (
      currentManager &&
      currentWorkspace?.executionMode === nextWorkspace.executionMode &&
      currentWorkspace.hostPath === nextWorkspace.hostPath
    ) {
      await currentManager.start()
      return
    }

    if (currentManager) {
      await currentManager.stop()
    }

    currentWorkspace = nextWorkspace
    currentManager = managerFactory(nextWorkspace)
    await currentManager.start()
  }

  /** Stops the current workspace runtime and clears the active workspace attachment. */
  async function detachWorkspace(): Promise<void> {
    if (currentManager) {
      await currentManager.stop()
    }

    currentManager = null
    currentWorkspace = null
  }

  return {
    attachWorkspace,
    detachWorkspace,
    getSnapshot,
    getWorkspaceDirectory,
    start,
    stop,
  }
}

/** Re-exports the workspace runtime factory under the older container terminology. */
export const createWorkspaceSessionContainerManager = createWorkspaceSessionRuntimeManager
