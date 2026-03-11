import { resolve } from 'node:path'

import { defaultSessionContainerImage } from '../config'
import {
  createDockerSessionContainerManager,
  type DockerSessionContainerManagerOptions,
  type SessionContainerManager,
  type SessionContainerSnapshot,
} from './session-container'

/** Represents one workspace-aware container manager that can reattach to different folders. */
export interface WorkspaceSessionContainerManager extends SessionContainerManager {
  attachWorkspace(workspaceDirectory: string): Promise<void>
  detachWorkspace(): Promise<void>
  getWorkspaceDirectory(): string | null
}

/** Represents the options used to create one workspace-aware container manager. */
export interface CreateWorkspaceSessionContainerManagerOptions
  extends DockerSessionContainerManagerOptions {
  managerFactory?: (workspaceDirectory: string) => SessionContainerManager
}

/** Returns one stopped container snapshot used before any workspace is attached. */
function createDetachedSnapshot(
  options: CreateWorkspaceSessionContainerManagerOptions,
): SessionContainerSnapshot {
  return {
    baseUrl: null,
    containerId: null,
    containerImage: options.image ?? defaultSessionContainerImage,
    containerName: null,
    error: '',
    openCodeError: '',
    openCodeStatus: 'stopped',
    openCodeVersion: null,
    startedAt: null,
    status: 'stopped',
  }
}

/** Creates one workspace-aware session-container manager for the Bun backend. */
export function createWorkspaceSessionContainerManager(
  options: CreateWorkspaceSessionContainerManagerOptions = {},
): WorkspaceSessionContainerManager {
  const managerFactory =
    options.managerFactory ??
    ((workspaceDirectory: string) =>
      createDockerSessionContainerManager({
        ...options,
        mountWorkspace: options.mountWorkspace ?? true,
        workspaceDirectory,
      }))
  let currentWorkspaceDirectory: string | null = null
  let currentManager: SessionContainerManager | null = null
  const detachedSnapshot = createDetachedSnapshot(options)

  /** Returns the latest session-container snapshot for the active workspace. */
  function getSnapshot(): SessionContainerSnapshot {
    if (!currentManager) {
      return { ...detachedSnapshot }
    }

    return currentManager.getSnapshot()
  }

  /** Returns the currently attached host workspace directory when it exists. */
  function getWorkspaceDirectory(): string | null {
    return currentWorkspaceDirectory
  }

  /** Starts the current workspace container when one workspace is attached. */
  async function start(): Promise<void> {
    if (!currentManager) {
      return
    }

    await currentManager.start()
  }

  /** Stops the current workspace container when one workspace is attached. */
  async function stop(): Promise<void> {
    if (!currentManager) {
      return
    }

    await currentManager.stop()
  }

  /** Replaces the current container with one attached to the provided host folder. */
  async function attachWorkspace(workspaceDirectory: string): Promise<void> {
    const nextWorkspaceDirectory = resolve(workspaceDirectory)

    if (currentManager && currentWorkspaceDirectory === nextWorkspaceDirectory) {
      await currentManager.start()
      return
    }

    if (currentManager) {
      await currentManager.stop()
    }

    currentWorkspaceDirectory = nextWorkspaceDirectory
    currentManager = managerFactory(nextWorkspaceDirectory)
    await currentManager.start()
  }

  /** Stops the current workspace container and clears the active workspace attachment. */
  async function detachWorkspace(): Promise<void> {
    if (currentManager) {
      await currentManager.stop()
    }

    currentManager = null
    currentWorkspaceDirectory = null
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
