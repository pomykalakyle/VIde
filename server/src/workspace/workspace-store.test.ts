import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'

import { expect, test } from 'bun:test'

import { createWorkspaceStore } from './workspace-store'

/** Returns one fresh temporary config directory for workspace-store tests. */
async function createTemporaryConfigDirectory(): Promise<string> {
  return await mkdtemp(path.join(tmpdir(), 'vide-workspace-store-'))
}

/** Verifies creating one workspace persists metadata to the local registry file. */
test('workspace store persists one created workspace in the registry file', async () => {
  const configDirectory = await createTemporaryConfigDirectory()
  const workspaceDirectory = path.join(configDirectory, 'workspace-a')

  try {
    await mkdir(workspaceDirectory, { recursive: true })
    const store = createWorkspaceStore(configDirectory)
    const snapshot = await store.createWorkspace({
      hostPath: workspaceDirectory,
    })
    const registryFile = JSON.parse(
      await readFile(path.join(configDirectory, 'workspaces.json'), 'utf8'),
    ) as {
      lastActiveWorkspaceId: string | null
      version: number
      workspaces: Array<{ hostPath: string; id: string; name: string }>
    }

    expect(snapshot.activeWorkspace?.hostPath).toBe(workspaceDirectory)
    expect(snapshot.workspaces).toHaveLength(1)
    expect(snapshot.lastActiveWorkspaceId).toBe(snapshot.activeWorkspace?.id ?? null)
    expect(registryFile.version).toBe(1)
    expect(registryFile.lastActiveWorkspaceId).toBe(snapshot.activeWorkspace?.id ?? null)
    expect(registryFile.workspaces[0]?.hostPath).toBe(workspaceDirectory)
    expect(registryFile.workspaces[0]?.name).toBe('workspace-a')
  } finally {
    await rm(configDirectory, { force: true, recursive: true })
  }
})

/** Verifies saving the current workspace updates its persisted display name. */
test('workspace store saveCurrentWorkspace updates the active workspace name', async () => {
  const configDirectory = await createTemporaryConfigDirectory()
  const workspaceDirectory = path.join(configDirectory, 'workspace-b')

  try {
    await mkdir(workspaceDirectory, { recursive: true })
    const store = createWorkspaceStore(configDirectory)

    await store.createWorkspace({
      hostPath: workspaceDirectory,
    })
    const snapshot = await store.saveCurrentWorkspace({
      name: 'Renamed Workspace',
    })

    expect(snapshot.activeWorkspace?.name).toBe('Renamed Workspace')
    expect(snapshot.workspaces[0]?.name).toBe('Renamed Workspace')
  } finally {
    await rm(configDirectory, { force: true, recursive: true })
  }
})

/** Verifies loading one saved workspace restores it as the active workspace. */
test('workspace store loadWorkspace switches the active workspace', async () => {
  const configDirectory = await createTemporaryConfigDirectory()
  const firstWorkspaceDirectory = path.join(configDirectory, 'workspace-c')
  const secondWorkspaceDirectory = path.join(configDirectory, 'workspace-d')

  try {
    await mkdir(firstWorkspaceDirectory, { recursive: true })
    await mkdir(secondWorkspaceDirectory, { recursive: true })
    const store = createWorkspaceStore(configDirectory)
    const firstSnapshot = await store.createWorkspace({
      hostPath: firstWorkspaceDirectory,
    })
    const secondSnapshot = await store.createWorkspace({
      hostPath: secondWorkspaceDirectory,
    })

    if (!firstSnapshot.activeWorkspace || !secondSnapshot.activeWorkspace) {
      throw new Error('The workspace test setup did not create the expected active workspaces.')
    }

    const loadedSnapshot = await store.loadWorkspace({
      workspaceId: firstSnapshot.activeWorkspace.id,
    })

    expect(loadedSnapshot.activeWorkspace?.id).toBe(firstSnapshot.activeWorkspace.id)
    expect(loadedSnapshot.activeWorkspace?.hostPath).toBe(firstWorkspaceDirectory)
    expect(loadedSnapshot.lastActiveWorkspaceId).toBe(firstSnapshot.activeWorkspace.id)
  } finally {
    await rm(configDirectory, { force: true, recursive: true })
  }
})
