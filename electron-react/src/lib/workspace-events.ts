import type { WorkspaceRegistrySnapshot } from './types/workspace'

const workspaceChangedEventName = 'vide:workspace:changed'

/** Broadcasts one renderer-wide workspace update after a workspace action completes. */
export function dispatchWorkspaceChangedEvent(snapshot: WorkspaceRegistrySnapshot): void {
  window.dispatchEvent(
    new CustomEvent<WorkspaceRegistrySnapshot>(workspaceChangedEventName, {
      detail: snapshot,
    }),
  )
}

/** Subscribes one renderer listener to the shared workspace-changed browser event. */
export function subscribeToWorkspaceChangedEvent(
  listener: (snapshot: WorkspaceRegistrySnapshot) => void,
): () => void {
  const handleWorkspaceChanged = (event: Event) => {
    const customEvent = event as CustomEvent<WorkspaceRegistrySnapshot>
    listener(customEvent.detail)
  }

  window.addEventListener(workspaceChangedEventName, handleWorkspaceChanged)

  return () => {
    window.removeEventListener(workspaceChangedEventName, handleWorkspaceChanged)
  }
}
