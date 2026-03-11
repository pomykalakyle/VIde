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
      executionMode: 'docker',
      hostPath: workspaceDirectory,
    })
    const registryFile = JSON.parse(
      await readFile(path.join(configDirectory, 'workspaces.json'), 'utf8'),
    ) as {
      lastActiveWorkspaceId: string | null
      version: number
      workspaces: Array<{
        executionMode: 'docker' | 'unsafe-host'
        hostPath: string
        id: string
        name: string
      }>
    }

    expect(snapshot.activeWorkspace?.executionMode).toBe('docker')
    expect(snapshot.activeWorkspace?.hostPath).toBe(workspaceDirectory)
    expect(snapshot.workspaces).toHaveLength(1)
    expect(snapshot.lastActiveWorkspaceId).toBe(snapshot.activeWorkspace?.id ?? null)
    expect(registryFile.version).toBe(2)
    expect(registryFile.lastActiveWorkspaceId).toBe(snapshot.activeWorkspace?.id ?? null)
    expect(registryFile.workspaces[0]?.executionMode).toBe('docker')
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
      executionMode: 'docker',
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
      executionMode: 'docker',
      hostPath: firstWorkspaceDirectory,
    })
    const secondSnapshot = await store.createWorkspace({
      executionMode: 'unsafe-host',
      hostPath: secondWorkspaceDirectory,
    })

    if (!firstSnapshot.activeWorkspace || !secondSnapshot.activeWorkspace) {
      throw new Error('The workspace test setup did not create the expected active workspaces.')
    }

    const loadedSnapshot = await store.loadWorkspace({
      workspaceId: firstSnapshot.activeWorkspace.id,
    })

    expect(loadedSnapshot.activeWorkspace?.id).toBe(firstSnapshot.activeWorkspace.id)
    expect(loadedSnapshot.activeWorkspace?.executionMode).toBe('docker')
    expect(loadedSnapshot.activeWorkspace?.hostPath).toBe(firstWorkspaceDirectory)
    expect(loadedSnapshot.lastActiveWorkspaceId).toBe(firstSnapshot.activeWorkspace.id)
  } finally {
    await rm(configDirectory, { force: true, recursive: true })
  }
})

/** Verifies deleting the active saved workspace removes only its metadata and clears selection. */
test('workspace store deleteWorkspace removes the saved record and clears active selection', async () => {
  const configDirectory = await createTemporaryConfigDirectory()
  const workspaceDirectory = path.join(configDirectory, 'workspace-e')

  try {
    await mkdir(workspaceDirectory, { recursive: true })
    const store = createWorkspaceStore(configDirectory)
    const createdSnapshot = await store.createWorkspace({
      executionMode: 'docker',
      hostPath: workspaceDirectory,
    })

    if (!createdSnapshot.activeWorkspace) {
      throw new Error('The workspace test setup did not create an active workspace.')
    }

    const deletedSnapshot = await store.deleteWorkspace({
      workspaceId: createdSnapshot.activeWorkspace.id,
    })

    expect(deletedSnapshot.activeWorkspace).toBeNull()
    expect(deletedSnapshot.lastActiveWorkspaceId).toBeNull()
    expect(deletedSnapshot.workspaces).toHaveLength(0)
  } finally {
    await rm(configDirectory, { force: true, recursive: true })
  }
})

/** Verifies legacy version 1 workspace records default to Docker execution mode. */
test('workspace store migrates legacy workspaces to docker execution mode', async () => {
  const configDirectory = await createTemporaryConfigDirectory()
  const workspaceDirectory = path.join(configDirectory, 'workspace-legacy')
  const workspaceId = 'ws_legacy'

  try {
    await mkdir(workspaceDirectory, { recursive: true })
    await Bun.write(
      path.join(configDirectory, 'workspaces.json'),
      `${JSON.stringify(
        {
          lastActiveWorkspaceId: workspaceId,
          version: 1,
          workspaces: [
            {
              createdAt: '2026-01-01T00:00:00.000Z',
              hostPath: workspaceDirectory,
              id: workspaceId,
              kind: 'local',
              lastOpenedAt: '2026-01-01T00:00:00.000Z',
              name: 'Legacy Workspace',
            },
          ],
        },
        null,
        2,
      )}\n`,
    )
    const store = createWorkspaceStore(configDirectory)
    const snapshot = await store.getSnapshot()

    expect(snapshot.activeWorkspace?.executionMode).toBe('docker')
    expect(snapshot.workspaces[0]?.executionMode).toBe('docker')
  } finally {
    await rm(configDirectory, { force: true, recursive: true })
  }
})

/** Verifies recreating one saved workspace updates its persisted execution mode. */
test('workspace store createWorkspace updates the execution mode for an existing host path', async () => {
  const configDirectory = await createTemporaryConfigDirectory()
  const workspaceDirectory = path.join(configDirectory, 'workspace-mode-update')

  try {
    await mkdir(workspaceDirectory, { recursive: true })
    const store = createWorkspaceStore(configDirectory)

    await store.createWorkspace({
      executionMode: 'docker',
      hostPath: workspaceDirectory,
    })
    const snapshot = await store.createWorkspace({
      executionMode: 'unsafe-host',
      hostPath: workspaceDirectory,
    })

    expect(snapshot.activeWorkspace?.executionMode).toBe('unsafe-host')
    expect(snapshot.workspaces[0]?.executionMode).toBe('unsafe-host')
  } finally {
    await rm(configDirectory, { force: true, recursive: true })
  }
})
