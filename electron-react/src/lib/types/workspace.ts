/** Represents one saved local workspace shown in the VIde workspace manager UI. */
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

/** Represents the request used to create or attach one workspace from a host folder. */
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
