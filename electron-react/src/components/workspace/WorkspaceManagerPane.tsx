import { useCallback, useEffect, useMemo, useState } from 'react'

import { dispatchWorkspaceChangedEvent, subscribeToWorkspaceChangedEvent } from '../../lib/workspace-events'
import type {
  WorkspaceExecutionMode,
  WorkspaceRecord,
  WorkspaceRegistrySnapshot,
} from '../../lib/types/workspace'

/** Returns one compact label for the provided workspace host path. */
function formatWorkspacePath(hostPath: string | null | undefined): string {
  return hostPath && hostPath.length > 0 ? hostPath : 'No workspace selected'
}

/** Returns one human-readable label for the provided workspace execution mode. */
function formatWorkspaceExecutionMode(executionMode: WorkspaceExecutionMode): string {
  return executionMode === 'unsafe-host' ? 'Unsafe Host' : 'Docker'
}

/** Renders one Dockview workspace-management panel for new, save, and load actions. */
export function WorkspaceManagerPane(): JSX.Element {
  const [confirmDeleteWorkspace, setConfirmDeleteWorkspace] = useState<WorkspaceRecord | null>(null)
  const [deletingWorkspaceId, setDeletingWorkspaceId] = useState<string | null>(null)
  const [draftExecutionMode, setDraftExecutionMode] = useState<WorkspaceExecutionMode>('docker')
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

  /** Returns whether the user confirmed one unsafe workspace action. */
  const confirmUnsafeWorkspaceAction = useCallback((workspaceName: string): boolean => {
    return window.confirm(
      `Unsafe host mode gives the agent full access to your computer outside the selected folder.\n\nContinue with "${workspaceName}"?`,
    )
  }, [])

  /** Opens the native folder picker and creates or reattaches the selected workspace. */
  const handleCreateWorkspace = useCallback(async (): Promise<void> => {
    if (isCreatingWorkspace) {
      return
    }

    setIsCreatingWorkspace(true)
    setWorkspaceError('')

    try {
      if (
        draftExecutionMode === 'unsafe-host' &&
        !confirmUnsafeWorkspaceAction('New Workspace')
      ) {
        return
      }

      const hostPath = await window.videApi.pickWorkspaceFolder()

      if (!hostPath) {
        return
      }

      const nextSummary = await window.videApi.createWorkspace({
        executionMode: draftExecutionMode,
        hostPath,
      })
      setSummary(nextSummary)
      dispatchWorkspaceChangedEvent(nextSummary)
    } catch (error) {
      setWorkspaceError(
        error instanceof Error ? error.message : 'The workspace could not be created.',
      )
    } finally {
      setIsCreatingWorkspace(false)
    }
  }, [confirmUnsafeWorkspaceAction, draftExecutionMode, isCreatingWorkspace])

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
  const handleLoadWorkspace = useCallback(async (workspace: WorkspaceRecord): Promise<void> => {
    if (loadingWorkspaceId) {
      return
    }

    if (
      workspace.executionMode === 'unsafe-host' &&
      !confirmUnsafeWorkspaceAction(workspace.name)
    ) {
      return
    }

    setLoadingWorkspaceId(workspace.id)
    setWorkspaceError('')

    try {
      const nextSummary = await window.videApi.loadWorkspace({
        workspaceId: workspace.id,
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
  }, [confirmUnsafeWorkspaceAction, loadingWorkspaceId])

  /** Opens the destructive confirmation modal for the selected saved workspace. */
  const handleRequestDeleteWorkspace = useCallback((workspace: WorkspaceRecord): void => {
    setConfirmDeleteWorkspace(workspace)
    setWorkspaceError('')
  }, [])

  /** Removes one saved workspace entry after the user has confirmed the warning. */
  const handleConfirmDeleteWorkspace = useCallback(async (): Promise<void> => {
    if (!confirmDeleteWorkspace || deletingWorkspaceId) {
      return
    }

    setDeletingWorkspaceId(confirmDeleteWorkspace.id)
    setWorkspaceError('')

    try {
      const nextSummary = await window.videApi.deleteWorkspace({
        workspaceId: confirmDeleteWorkspace.id,
      })
      setSummary(nextSummary)
      setConfirmDeleteWorkspace(null)
      dispatchWorkspaceChangedEvent(nextSummary)
    } catch (error) {
      setWorkspaceError(
        error instanceof Error ? error.message : 'The saved workspace could not be deleted.',
      )
    } finally {
      setDeletingWorkspaceId(null)
    }
  }, [confirmDeleteWorkspace, deletingWorkspaceId])

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
          Choose a host folder, pick an execution mode, then save or load workspace metadata from VIde.
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

        <p className="mt-2 text-sm text-[var(--color-muted)]">
          Mode: {activeWorkspace ? formatWorkspaceExecutionMode(activeWorkspace.executionMode) : 'Unavailable'}
        </p>

        <div className="mt-4 grid gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] p-4">
          <p className="text-sm font-semibold text-[var(--color-text)]">New workspace mode</p>
          <label className="flex items-start gap-3 text-sm text-[var(--color-text)]">
            <input
              type="radio"
              className="mt-1"
              checked={draftExecutionMode === 'docker'}
              onChange={() => {
                setDraftExecutionMode('docker')
              }}
            />
            <span>
              Docker (isolated)
            </span>
          </label>
          <label className="flex items-start gap-3 text-sm text-[var(--color-text)]">
            <input
              type="radio"
              className="mt-1"
              checked={draftExecutionMode === 'unsafe-host'}
              onChange={() => {
                setDraftExecutionMode('unsafe-host')
              }}
            />
            <span>
              Unsafe Host (full access)
            </span>
          </label>
          {draftExecutionMode === 'unsafe-host' ? (
            <p className="text-sm text-amber-200">
              Unsafe host mode gives the agent full access to your computer outside the selected folder.
            </p>
          ) : null}
        </div>

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
          <button
            type="button"
            className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-2 text-sm font-medium text-rose-200 transition hover:border-rose-400 disabled:cursor-not-allowed disabled:opacity-50"
            onClick={() => {
              if (activeWorkspace) {
                handleRequestDeleteWorkspace(activeWorkspace)
              }
            }}
            disabled={activeWorkspace === null || deletingWorkspaceId !== null}
          >
            Delete Saved Workspace
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
                      <p className="mt-2 text-sm text-[var(--color-muted)]">
                        Mode: {formatWorkspaceExecutionMode(workspace.executionMode)}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <button
                        type="button"
                        className="rounded-xl border border-[var(--color-border)] bg-[var(--color-panel)] px-4 py-2 text-sm font-medium text-[var(--color-text)] transition hover:border-[var(--color-accent)] disabled:cursor-not-allowed disabled:opacity-50"
                        onClick={() => void handleLoadWorkspace(workspace)}
                        disabled={loadingWorkspaceId !== null || isActiveWorkspace}
                      >
                        {loadingWorkspaceId === workspace.id
                          ? 'Loading...'
                          : isActiveWorkspace
                            ? 'Loaded'
                            : 'Load Workspace'}
                      </button>
                      <button
                        type="button"
                        className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-2 text-sm font-medium text-rose-200 transition hover:border-rose-400 disabled:cursor-not-allowed disabled:opacity-50"
                        onClick={() => {
                          handleRequestDeleteWorkspace(workspace)
                        }}
                        disabled={loadingWorkspaceId !== null || deletingWorkspaceId !== null}
                      >
                        Delete
                      </button>
                    </div>
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

      {confirmDeleteWorkspace ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6">
          <div className="w-full max-w-lg rounded-2xl border border-rose-500/30 bg-[var(--color-panel)] p-6 shadow-2xl">
            <h3 className="text-lg font-semibold text-[var(--color-text)]">Delete Saved Workspace?</h3>
            <p className="mt-3 text-sm text-[var(--color-muted)]">
              This cannot be undone. VIde will remove this saved workspace from its list, but it will not delete any files from your computer.
            </p>
            <div className="mt-4 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] px-4 py-3">
              <p className="text-sm font-semibold text-[var(--color-text)]">
                {confirmDeleteWorkspace.name}
              </p>
              <p className="mt-1 break-all text-sm text-[var(--color-muted)]">
                {confirmDeleteWorkspace.hostPath}
              </p>
            </div>
            <div className="mt-6 flex justify-end gap-3">
              <button
                type="button"
                className="rounded-xl border border-[var(--color-border)] bg-[var(--color-panel)] px-4 py-2 text-sm font-medium text-[var(--color-text)] transition hover:border-[var(--color-accent)] disabled:cursor-not-allowed disabled:opacity-50"
                onClick={() => {
                  setConfirmDeleteWorkspace(null)
                }}
                disabled={deletingWorkspaceId !== null}
              >
                Cancel
              </button>
              <button
                type="button"
                className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-2 text-sm font-medium text-rose-200 transition hover:border-rose-400 disabled:cursor-not-allowed disabled:opacity-50"
                onClick={() => void handleConfirmDeleteWorkspace()}
                disabled={deletingWorkspaceId !== null}
              >
                {deletingWorkspaceId ? 'Deleting...' : 'Delete Saved Workspace'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  )
}
