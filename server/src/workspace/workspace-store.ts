import { randomUUID } from 'node:crypto'
import { basename, dirname, join, resolve } from 'node:path'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'

const workspaceRegistryFileName = 'workspaces.json'

/** Represents one saved local workspace shown in the VIde workspace manager. */
export interface WorkspaceRecord {
  createdAt: string
  hostPath: string
  id: string
  kind: 'local'
  lastOpenedAt: string
  name: string
}

/** Represents one renderer-safe snapshot of saved workspaces and the active selection. */
export interface WorkspaceRegistrySnapshot {
  activeWorkspace: WorkspaceRecord | null
  lastActiveWorkspaceId: string | null
  workspaces: WorkspaceRecord[]
}

/** Represents the on-disk JSON file stored for the saved workspace registry. */
interface WorkspaceRegistryFile {
  lastActiveWorkspaceId: string | null
  version: 1
  workspaces: WorkspaceRecord[]
}

/** Represents the request used to register a host folder as a saved workspace. */
export interface CreateWorkspaceRequest {
  hostPath: string
}

/** Represents the request used to persist metadata for the current active workspace. */
export interface SaveWorkspaceRequest {
  name: string
}

/** Represents the request used to load one previously saved workspace. */
export interface LoadWorkspaceRequest {
  workspaceId: string
}

/** Represents the local workspace registry owned by the Bun backend. */
export interface WorkspaceStore {
  createWorkspace(request: CreateWorkspaceRequest): Promise<WorkspaceRegistrySnapshot>
  getSnapshot(): Promise<WorkspaceRegistrySnapshot>
  getWorkspaceById(workspaceId: string): Promise<WorkspaceRecord | null>
  loadWorkspace(request: LoadWorkspaceRequest): Promise<WorkspaceRegistrySnapshot>
  saveCurrentWorkspace(request: SaveWorkspaceRequest): Promise<WorkspaceRegistrySnapshot>
}

/** Returns whether the provided value is one non-null object record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** Returns the parsed JSON contents of one file path or null when it is missing. */
async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    const fileContents = await readFile(filePath, 'utf8')
    return JSON.parse(fileContents) as T
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return null
    }

    throw error
  }
}

/** Writes one UTF-8 file atomically by renaming a temporary file into place. */
async function writeFileAtomically(filePath: string, fileContents: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true })
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`

  await writeFile(temporaryPath, fileContents, 'utf8')
  await rename(temporaryPath, filePath)
}

/** Writes one JSON file atomically using stable indentation. */
async function writeJsonFileAtomically(filePath: string, value: unknown): Promise<void> {
  await writeFileAtomically(filePath, `${JSON.stringify(value, null, 2)}\n`)
}

/** Returns one normalized absolute host path for workspace metadata operations. */
function normalizeHostPath(hostPath: string): string {
  return resolve(hostPath)
}

/** Returns one fallback workspace name derived from the provided host path. */
function getDefaultWorkspaceName(hostPath: string): string {
  const normalizedHostPath = normalizeHostPath(hostPath)
  const derivedName = basename(normalizedHostPath)

  return derivedName.length > 0 ? derivedName : normalizedHostPath
}

/** Returns whether the provided unknown value matches one saved workspace record. */
function isWorkspaceRecord(value: unknown): value is WorkspaceRecord {
  return (
    isRecord(value) &&
    typeof value.createdAt === 'string' &&
    typeof value.hostPath === 'string' &&
    typeof value.id === 'string' &&
    value.kind === 'local' &&
    typeof value.lastOpenedAt === 'string' &&
    typeof value.name === 'string'
  )
}

/** Returns one validated workspace registry file or a default empty registry. */
function parseWorkspaceRegistryFile(value: unknown): WorkspaceRegistryFile {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.workspaces)) {
    return {
      lastActiveWorkspaceId: null,
      version: 1,
      workspaces: [],
    }
  }

  const workspaces = value.workspaces
    .filter((workspace): workspace is WorkspaceRecord => isWorkspaceRecord(workspace))
    .map((workspace) => ({
      ...workspace,
      hostPath: normalizeHostPath(workspace.hostPath),
    }))

  return {
    lastActiveWorkspaceId:
      typeof value.lastActiveWorkspaceId === 'string' ? value.lastActiveWorkspaceId : null,
    version: 1,
    workspaces,
  }
}

/** Returns one renderer-safe snapshot from the validated registry file. */
function createWorkspaceRegistrySnapshot(registryFile: WorkspaceRegistryFile): WorkspaceRegistrySnapshot {
  const activeWorkspace =
    registryFile.workspaces.find((workspace) => workspace.id === registryFile.lastActiveWorkspaceId) ?? null

  return {
    activeWorkspace,
    lastActiveWorkspaceId: activeWorkspace?.id ?? null,
    workspaces: [...registryFile.workspaces].sort((leftWorkspace, rightWorkspace) =>
      rightWorkspace.lastOpenedAt.localeCompare(leftWorkspace.lastOpenedAt),
    ),
  }
}

/** Creates one Bun-owned workspace registry store backed by one JSON file on disk. */
export function createWorkspaceStore(configDirectory: string): WorkspaceStore {
  const workspaceRegistryFilePath = join(configDirectory, workspaceRegistryFileName)

  /** Returns the latest validated workspace registry file from local disk. */
  async function readWorkspaceRegistryFile(): Promise<WorkspaceRegistryFile> {
    return parseWorkspaceRegistryFile(await readJsonFile<unknown>(workspaceRegistryFilePath))
  }

  /** Writes the provided workspace registry file to local disk atomically. */
  async function writeWorkspaceRegistryFile(registryFile: WorkspaceRegistryFile): Promise<void> {
    await writeJsonFileAtomically(workspaceRegistryFilePath, registryFile)
  }

  /** Returns one saved workspace by identifier when it exists. */
  async function getWorkspaceById(workspaceId: string): Promise<WorkspaceRecord | null> {
    const registryFile = await readWorkspaceRegistryFile()
    return registryFile.workspaces.find((workspace) => workspace.id === workspaceId) ?? null
  }

  /** Returns the latest renderer-safe saved-workspace snapshot. */
  async function getSnapshot(): Promise<WorkspaceRegistrySnapshot> {
    return createWorkspaceRegistrySnapshot(await readWorkspaceRegistryFile())
  }

  /** Registers one host folder as a saved workspace and marks it active. */
  async function createWorkspace(
    request: CreateWorkspaceRequest,
  ): Promise<WorkspaceRegistrySnapshot> {
    const normalizedHostPath = normalizeHostPath(request.hostPath)
    const openedAt = new Date().toISOString()
    const registryFile = await readWorkspaceRegistryFile()
    const existingWorkspaceIndex = registryFile.workspaces.findIndex(
      (workspace) => workspace.hostPath === normalizedHostPath,
    )

    if (existingWorkspaceIndex >= 0) {
      const existingWorkspace = registryFile.workspaces[existingWorkspaceIndex]

      registryFile.workspaces[existingWorkspaceIndex] = {
        ...existingWorkspace,
        lastOpenedAt: openedAt,
      }
      registryFile.lastActiveWorkspaceId = existingWorkspace.id
      await writeWorkspaceRegistryFile(registryFile)
      return createWorkspaceRegistrySnapshot(registryFile)
    }

    const nextWorkspace: WorkspaceRecord = {
      createdAt: openedAt,
      hostPath: normalizedHostPath,
      id: `ws_${randomUUID()}`,
      kind: 'local',
      lastOpenedAt: openedAt,
      name: getDefaultWorkspaceName(normalizedHostPath),
    }
    registryFile.workspaces.push(nextWorkspace)
    registryFile.lastActiveWorkspaceId = nextWorkspace.id
    await writeWorkspaceRegistryFile(registryFile)
    return createWorkspaceRegistrySnapshot(registryFile)
  }

  /** Marks one previously saved workspace active and updates its last-opened timestamp. */
  async function loadWorkspace(request: LoadWorkspaceRequest): Promise<WorkspaceRegistrySnapshot> {
    const registryFile = await readWorkspaceRegistryFile()
    const workspaceIndex = registryFile.workspaces.findIndex(
      (workspace) => workspace.id === request.workspaceId,
    )

    if (workspaceIndex < 0) {
      throw new Error('The requested workspace could not be found.')
    }

    const existingWorkspace = registryFile.workspaces[workspaceIndex]
    registryFile.workspaces[workspaceIndex] = {
      ...existingWorkspace,
      lastOpenedAt: new Date().toISOString(),
    }
    registryFile.lastActiveWorkspaceId = existingWorkspace.id
    await writeWorkspaceRegistryFile(registryFile)
    return createWorkspaceRegistrySnapshot(registryFile)
  }

  /** Updates the current active workspace metadata and keeps it selected. */
  async function saveCurrentWorkspace(
    request: SaveWorkspaceRequest,
  ): Promise<WorkspaceRegistrySnapshot> {
    const trimmedName = request.name.trim()

    if (trimmedName.length === 0) {
      throw new Error('The workspace name cannot be empty.')
    }

    const registryFile = await readWorkspaceRegistryFile()
    const activeWorkspaceId = registryFile.lastActiveWorkspaceId

    if (!activeWorkspaceId) {
      throw new Error('There is no active workspace to save.')
    }

    const workspaceIndex = registryFile.workspaces.findIndex(
      (workspace) => workspace.id === activeWorkspaceId,
    )

    if (workspaceIndex < 0) {
      throw new Error('The active workspace could not be found.')
    }

    const activeWorkspace = registryFile.workspaces[workspaceIndex]
    registryFile.workspaces[workspaceIndex] = {
      ...activeWorkspace,
      lastOpenedAt: new Date().toISOString(),
      name: trimmedName,
    }
    await writeWorkspaceRegistryFile(registryFile)
    return createWorkspaceRegistrySnapshot(registryFile)
  }

  return {
    createWorkspace,
    getSnapshot,
    getWorkspaceById,
    loadWorkspace,
    saveCurrentWorkspace,
  }
}
