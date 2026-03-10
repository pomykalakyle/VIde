import { useCallback, useEffect, useMemo, useState } from 'react'

import { dispatchWorkspaceChangedEvent, subscribeToWorkspaceChangedEvent } from '../../lib/workspace-events'
import type { WorkspaceRegistrySnapshot } from '../../lib/types/workspace'

/** Returns one compact label for the provided workspace host path. */
function formatWorkspacePath(hostPath: string | null | undefined): string {
  return hostPath && hostPath.length > 0 ? hostPath : 'No workspace selected'
}

/** Renders one Dockview workspace-management panel for new, save, and load actions. */
export function WorkspaceManagerPane(): JSX.Element {
  const [draftWorkspaceName, setDraftWorkspaceName] = useState('')
  const [isCreatingWorkspace, setIsCreatingWorkspace] = useState(false)
  const [isLoadingSummary, setIsLoadingSummary] = useState(true)
  const [isSavingWorkspace, setIsSavingWorkspace] = useState(false)
  const [loadingWorkspaceId, setLoadingWorkspaceId] = useState<string | null>(null)
  const [summary, setSummary] = useState<WorkspaceRegistrySnapshot | null>(null)
  const [workspaceError, setWorkspaceError] = useState('')

  /** Refreshes the latest workspace registry snapshot from the Electron bridge. */
  const refreshSummary = useCallback(async (): Promise<void> => {
    setIsLoadingSummary(true)

    try {
      const nextSummary = await window.videApi.getWorkspaceSummary()
      setSummary(nextSummary)
      setWorkspaceError('')
    } catch (error) {
      setWorkspaceError(
        error instanceof Error ? error.message : 'The workspace list could not be loaded.',
      )
    } finally {
      setIsLoadingSummary(false)
    }
  }, [])

  useEffect(() => {
    void refreshSummary()

    return subscribeToWorkspaceChangedEvent((nextSummary) => {
      setSummary(nextSummary)
      setWorkspaceError('')
      setIsLoadingSummary(false)
    })
  }, [refreshSummary])

  useEffect(() => {
    setDraftWorkspaceName(summary?.activeWorkspace?.name ?? '')
  }, [summary?.activeWorkspace?.id, summary?.activeWorkspace?.name])

  /** Opens the native folder picker and creates or reattaches the selected workspace. */
  const handleCreateWorkspace = useCallback(async (): Promise<void> => {
    if (isCreatingWorkspace) {
      return
    }

    setIsCreatingWorkspace(true)
    setWorkspaceError('')

    try {
      const hostPath = await window.videApi.pickWorkspaceFolder()

      if (!hostPath) {
        return
      }

      const nextSummary = await window.videApi.createWorkspace({ hostPath })
      setSummary(nextSummary)
      dispatchWorkspaceChangedEvent(nextSummary)
    } catch (error) {
      setWorkspaceError(
        error instanceof Error ? error.message : 'The workspace could not be created.',
      )
    } finally {
      setIsCreatingWorkspace(false)
    }
  }, [isCreatingWorkspace])

  /** Saves the current active workspace metadata using the draft display name. */
  const handleSaveWorkspace = useCallback(async (): Promise<void> => {
    if (isSavingWorkspace) {
      return
    }

    setIsSavingWorkspace(true)
    setWorkspaceError('')

    try {
      const nextSummary = await window.videApi.saveWorkspace({
        name: draftWorkspaceName,
      })
      setSummary(nextSummary)
      dispatchWorkspaceChangedEvent(nextSummary)
    } catch (error) {
      setWorkspaceError(
        error instanceof Error ? error.message : 'The workspace could not be saved.',
      )
    } finally {
      setIsSavingWorkspace(false)
    }
  }, [draftWorkspaceName, isSavingWorkspace])

  /** Loads one saved workspace and reattaches the runtime to its host folder. */
  const handleLoadWorkspace = useCallback(async (workspaceId: string): Promise<void> => {
    if (loadingWorkspaceId) {
      return
    }

    setLoadingWorkspaceId(workspaceId)
    setWorkspaceError('')

    try {
      const nextSummary = await window.videApi.loadWorkspace({
        workspaceId,
      })
      setSummary(nextSummary)
      dispatchWorkspaceChangedEvent(nextSummary)
    } catch (error) {
      setWorkspaceError(
        error instanceof Error ? error.message : 'The workspace could not be loaded.',
      )
    } finally {
      setLoadingWorkspaceId(null)
    }
  }, [loadingWorkspaceId])

  const activeWorkspace = summary?.activeWorkspace ?? null
  const canSaveWorkspace = useMemo(
    () => activeWorkspace !== null && draftWorkspaceName.trim().length > 0 && !isSavingWorkspace,
    [activeWorkspace, draftWorkspaceName, isSavingWorkspace],
  )

  return (
    <section className="flex h-full min-h-0 flex-col gap-4 overflow-y-auto bg-[var(--color-bg)] p-5 text-[var(--color-text)]">
      <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-panel)] p-4">
        <h2 className="text-base font-semibold">Workspace Manager</h2>
        <p className="mt-1 text-sm text-[var(--color-muted)]">
          Create a workspace by choosing the host folder that Docker will bind-mount, then save or load workspace metadata from VIde.
        </p>
      </div>

      <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-panel)] p-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-sm font-semibold text-[var(--color-text)]">Current Workspace</p>
            <p className="mt-1 text-sm text-[var(--color-muted)]">
              {activeWorkspace ? activeWorkspace.name : 'None selected'}
            </p>
          </div>
          <button
            type="button"
            className="rounded-xl border border-[var(--color-border)] bg-[var(--color-panel)] px-4 py-2 text-sm font-medium text-[var(--color-text)] transition hover:border-[var(--color-accent)] disabled:cursor-not-allowed disabled:opacity-50"
            onClick={() => void handleCreateWorkspace()}
            disabled={isCreatingWorkspace}
          >
            {isCreatingWorkspace ? 'Choosing folder...' : 'New Workspace'}
          </button>
        </div>

        <p className="mt-4 break-all text-sm text-[var(--color-muted)]">
          {formatWorkspacePath(activeWorkspace?.hostPath)}
        </p>

        <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-end">
          <label className="flex min-w-0 flex-1 flex-col gap-2 text-sm text-[var(--color-muted)]">
            Workspace name
            <input
              type="text"
              className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm text-[var(--color-text)] outline-none transition focus:border-[var(--color-accent)]"
              value={draftWorkspaceName}
              onChange={(event) => {
                setDraftWorkspaceName(event.target.value)
              }}
              placeholder="Choose a saved workspace name"
              disabled={activeWorkspace === null}
            />
          </label>
          <button
            type="button"
            className="rounded-xl border border-[var(--color-border)] bg-[var(--color-panel)] px-4 py-2 text-sm font-medium text-[var(--color-text)] transition hover:border-[var(--color-accent)] disabled:cursor-not-allowed disabled:opacity-50"
            onClick={() => void handleSaveWorkspace()}
            disabled={!canSaveWorkspace}
          >
            {isSavingWorkspace ? 'Saving...' : 'Save Workspace'}
          </button>
        </div>
      </div>

      <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-panel)] p-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-sm font-semibold text-[var(--color-text)]">Saved Workspaces</p>
            <p className="mt-1 text-sm text-[var(--color-muted)]">
              {isLoadingSummary ? 'Loading workspaces...' : `${summary?.workspaces.length ?? 0} saved`}
            </p>
          </div>
        </div>

        <div className="mt-4 flex flex-col gap-3">
          {summary?.workspaces.length ? (
            summary.workspaces.map((workspace) => {
              const isActiveWorkspace = workspace.id === summary.lastActiveWorkspaceId

              return (
                <div
                  key={workspace.id}
                  className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg)] p-4"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-[var(--color-text)]">
                        {workspace.name}
                      </p>
                      <p className="mt-1 break-all text-sm text-[var(--color-muted)]">
                        {workspace.hostPath}
                      </p>
                    </div>
                    <button
                      type="button"
                      className="rounded-xl border border-[var(--color-border)] bg-[var(--color-panel)] px-4 py-2 text-sm font-medium text-[var(--color-text)] transition hover:border-[var(--color-accent)] disabled:cursor-not-allowed disabled:opacity-50"
                      onClick={() => void handleLoadWorkspace(workspace.id)}
                      disabled={loadingWorkspaceId !== null || isActiveWorkspace}
                    >
                      {loadingWorkspaceId === workspace.id
                        ? 'Loading...'
                        : isActiveWorkspace
                          ? 'Loaded'
                          : 'Load Workspace'}
                    </button>
                  </div>
                </div>
              )
            })
          ) : (
            <div className="rounded-2xl border border-dashed border-[var(--color-border)] px-4 py-6 text-sm text-[var(--color-muted)]">
              No saved workspaces yet. Choose `New Workspace` to register your first host folder.
            </div>
          )}
        </div>
      </div>

      {workspaceError ? (
        <div className="rounded-2xl border border-rose-500/30 bg-rose-500/12 px-4 py-3 text-sm text-rose-200">
          {workspaceError}
        </div>
      ) : null}
    </section>
  )
}
