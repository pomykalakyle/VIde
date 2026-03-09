import { useCallback, useEffect, useRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import {
  DockviewComponent,
  type DockviewApi,
  type GroupPanelPartInitParameters,
  type IContentRenderer,
} from 'dockview-core'

import { BackendStatusPane } from '../backend/BackendStatusPane'
import { ConversationPane } from '../conversation/ConversationPane'

const backendStatusPanelId = 'backend-status'
const conversationPanelId = 'conversation'
const floatingPanelMargin = 24
const lockedGroupMode = 'no-drop-target'

/** Represents the props used to register workspace panel openers with the shell. */
interface DockviewHostProps {
  registerOpenConversationPanel?: (opener: (() => void) | null) => void
  registerOpenBackendStatusPanel?: (opener: (() => void) | null) => void
}

/** Represents one React render callback used inside a Dockview content renderer. */
type PanelRenderFactory = () => JSX.Element

/** Renders one React component into a Dockview panel body. */
class ReactContentRenderer implements IContentRenderer {
  readonly element = document.createElement('div')
  private readonly renderPanel: PanelRenderFactory
  private root: Root | null = null

  /** Stores the React panel render function and prepares the host element. */
  constructor(renderPanel: PanelRenderFactory) {
    this.renderPanel = renderPanel
    this.element.style.height = '100%'
    this.element.style.minHeight = '0'
    this.element.style.width = '100%'
  }

  /** Mounts the React panel into the Dockview content element. */
  init(_parameters: GroupPanelPartInitParameters): void {
    this.root = createRoot(this.element)
    this.root.render(this.renderPanel())
  }

  /** Unmounts the React panel when Dockview disposes the content renderer. */
  dispose(): void {
    this.root?.unmount()
    this.root = null
  }
}

/** Creates one Dockview renderer for the requested panel component name. */
function createComponentRenderer(componentName: string): IContentRenderer {
  if (componentName === 'backend-status') {
    return new ReactContentRenderer(() => <BackendStatusPane />)
  }

  if (componentName === 'conversation') {
    return new ReactContentRenderer(() => <ConversationPane />)
  }

  throw new Error(`Unsupported Dockview component: ${componentName}`)
}

/** Returns the current Dockview host bounds used to size floating panels. */
function getHostBounds(hostElement: HTMLDivElement | null): { width: number; height: number } {
  const width = hostElement?.clientWidth ?? window.innerWidth
  const height = hostElement?.clientHeight ?? window.innerHeight

  return { width, height }
}

/** Returns the initial floating bounds for the main chat panel. */
function getConversationFloatingBounds(
  hostElement: HTMLDivElement | null,
): { width: number; height: number; x: number; y: number } {
  const { width: hostWidth, height: hostHeight } = getHostBounds(hostElement)
  const width = Math.min(Math.max(Math.round(hostWidth * 0.72), 720), hostWidth - floatingPanelMargin * 2)
  const height = Math.min(Math.max(Math.round(hostHeight * 0.8), 560), hostHeight - floatingPanelMargin * 2)
  const x = Math.max(floatingPanelMargin, Math.round((hostWidth - width) / 2))
  const y = Math.max(floatingPanelMargin, Math.round((hostHeight - height) / 2))

  return { width, height, x, y }
}

/** Returns the initial floating bounds for the backend status panel. */
function getBackendStatusFloatingBounds(
  hostElement: HTMLDivElement | null,
): { width: number; height: number; x: number; y: number } {
  const { width: hostWidth, height: hostHeight } = getHostBounds(hostElement)
  const maxWidth = Math.max(280, hostWidth - floatingPanelMargin * 2)
  const maxHeight = Math.max(240, hostHeight - floatingPanelMargin * 2)
  const width = Math.min(Math.max(Math.round(hostWidth * 0.42), 520), Math.min(680, maxWidth))
  const height = Math.min(Math.max(Math.round(hostHeight * 0.78), 560), Math.min(760, maxHeight))
  const x = Math.max(floatingPanelMargin, hostWidth - width - floatingPanelMargin)
  const y = floatingPanelMargin

  return { width, height, x, y }
}

/** Locks one Dockview group so it cannot accept additional dropped panels. */
function lockPanelGroup(dockviewApi: DockviewApi | null, panelId: string): void {
  const panel = dockviewApi?.getPanel(panelId)

  if (!panel) {
    return
  }

  panel.api.group.locked = lockedGroupMode
}

/** Renders and manages the Dockview workspace host for the React migration shell. */
export function DockviewHost({
  registerOpenConversationPanel = () => {},
  registerOpenBackendStatusPanel = () => {},
}: DockviewHostProps): JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const dockviewApiRef = useRef<DockviewApi | null>(null)

  /** Focuses the existing chat panel or creates it when it is missing. */
  const ensureConversationPanelOpen = useCallback((): void => {
    const dockviewApi = dockviewApiRef.current

    if (!dockviewApi) {
      return
    }

    const existingPanel = dockviewApi.getPanel(conversationPanelId)

    if (existingPanel) {
      lockPanelGroup(dockviewApi, conversationPanelId)
      existingPanel.api.setActive()
      dockviewApi.focus()
      return
    }

    const panel = dockviewApi.addPanel({
      id: conversationPanelId,
      component: 'conversation',
      title: 'Chat',
      floating: getConversationFloatingBounds(hostRef.current),
    })

    panel.api.group.locked = lockedGroupMode
  }, [])

  /** Focuses the existing backend status panel or creates it when it is missing. */
  const ensureBackendStatusPanelOpen = useCallback((): void => {
    const dockviewApi = dockviewApiRef.current

    if (!dockviewApi) {
      return
    }

    const existingPanel = dockviewApi.getPanel(backendStatusPanelId)

    if (existingPanel) {
      lockPanelGroup(dockviewApi, backendStatusPanelId)
      existingPanel.api.setActive()
      dockviewApi.focus()
      return
    }

    const panel = dockviewApi.addPanel({
      id: backendStatusPanelId,
      component: 'backend-status',
      title: 'Runtime Status',
      floating: getBackendStatusFloatingBounds(hostRef.current),
    })

    panel.api.group.locked = lockedGroupMode
  }, [])

  useEffect(() => {
    if (!hostRef.current) {
      return
    }

    const dockview = new DockviewComponent(hostRef.current, {
      createComponent: (options) => createComponentRenderer(options.name),
      floatingGroupBounds: 'boundedWithinViewport',
    })

    dockviewApiRef.current = dockview.api
    const addPanelDisposable = dockview.api.onDidAddPanel((panel) => {
      panel.api.group.locked = lockedGroupMode
    })

    registerOpenConversationPanel(ensureConversationPanelOpen)
    registerOpenBackendStatusPanel(ensureBackendStatusPanelOpen)
    ensureConversationPanelOpen()

    return () => {
      addPanelDisposable.dispose()
      registerOpenConversationPanel(null)
      registerOpenBackendStatusPanel(null)
      dockviewApiRef.current = null
      dockview.dispose()
    }
  }, [
    ensureBackendStatusPanelOpen,
    ensureConversationPanelOpen,
    registerOpenBackendStatusPanel,
    registerOpenConversationPanel,
  ])

  return (
    <div
      ref={hostRef}
      className="vide-dockview dockview-theme-dark h-full min-h-0 w-full"
    />
  )
}
