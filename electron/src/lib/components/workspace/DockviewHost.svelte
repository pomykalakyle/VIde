<svelte:options runes={true} />

<script lang="ts">
  import { mount, unmount } from 'svelte'
  import {
    DockviewComponent,
    type DockviewApi,
    type GroupPanelPartInitParameters,
    type IContentRenderer,
  } from 'dockview-core'
  import BackendStatusPane from '../backend/BackendStatusPane.svelte'
  import ConversationPane from '../conversation/ConversationPane.svelte'
  import { theme } from '../../theme/theme-state.svelte'

  const backendStatusPanelId = 'backend-status'
  const conversationPanelId = 'conversation'

  let {
    registerOpenConversationPanel = () => {},
    registerOpenBackendStatusPanel = () => {},
  }: {
    registerOpenConversationPanel?: (opener: (() => void) | null) => void
    registerOpenBackendStatusPanel?: (opener: (() => void) | null) => void
  } = $props()

  let hostElement: HTMLDivElement | null = null
  let dockviewApi = $state<DockviewApi | null>(null)
  let dockviewThemeClass = $derived(theme.current === 'light' ? 'dockview-theme-light' : 'dockview-theme-dark')

  /** Renders the chat panel content inside one Dockview panel body. */
  class ConversationContentRenderer implements IContentRenderer {
    readonly element = document.createElement('div')

    #component: Record<string, any> | null = null

    constructor() {
      this.element.style.height = '100%'
      this.element.style.minHeight = '0'
      this.element.style.width = '100%'
    }

    init(_parameters: GroupPanelPartInitParameters): void {
      this.#component = mount(ConversationPane, {
        target: this.element,
      })
    }

    dispose(): void {
      if (!this.#component) {
        return
      }

      void unmount(this.#component)
      this.#component = null
    }
  }

  /** Renders the backend status panel content inside one Dockview panel body. */
  class BackendStatusContentRenderer implements IContentRenderer {
    readonly element = document.createElement('div')

    #component: Record<string, any> | null = null

    constructor() {
      this.element.style.height = '100%'
      this.element.style.minHeight = '0'
      this.element.style.width = '100%'
    }

    init(_parameters: GroupPanelPartInitParameters): void {
      this.#component = mount(BackendStatusPane, {
        target: this.element,
      })
    }

    dispose(): void {
      if (!this.#component) {
        return
      }

      void unmount(this.#component)
      this.#component = null
    }
  }

  /** Creates one Dockview renderer for the requested panel component name. */
  function createComponentRenderer(componentName: string): IContentRenderer {
    if (componentName === 'backend-status') {
      return new BackendStatusContentRenderer()
    }

    if (componentName === 'conversation') {
      return new ConversationContentRenderer()
    }

    throw new Error(`Unsupported Dockview component: ${componentName}`)
  }

  /** Focuses the existing chat panel or creates it when it is missing. */
  function ensureConversationPanelOpen(): void {
    if (!dockviewApi) {
      return
    }

    const existingPanel = dockviewApi.getPanel(conversationPanelId)

    if (existingPanel) {
      existingPanel.api.setActive()
      dockviewApi.focus()
      return
    }

    dockviewApi.addPanel({
      id: conversationPanelId,
      component: 'conversation',
      title: 'Chat',
    })
  }

  /** Focuses the existing backend status panel or creates it when it is missing. */
  function ensureBackendStatusPanelOpen(): void {
    if (!dockviewApi) {
      return
    }

    const existingPanel = dockviewApi.getPanel(backendStatusPanelId)

    if (existingPanel) {
      existingPanel.api.setActive()
      dockviewApi.focus()
      return
    }

    const referenceConversationPanel = dockviewApi.getPanel(conversationPanelId)

    dockviewApi.addPanel({
      id: backendStatusPanelId,
      component: 'backend-status',
      title: 'Backend Status',
      ...(referenceConversationPanel
        ? {
            position: {
              direction: 'right' as const,
              referencePanel: conversationPanelId,
            },
          }
        : {}),
    })
  }

  $effect(() => {
    if (!hostElement) {
      return
    }

    const dockview = new DockviewComponent(hostElement, {
      createComponent: (options) => createComponentRenderer(options.name),
    })

    dockviewApi = dockview.api
    registerOpenConversationPanel(ensureConversationPanelOpen)
    registerOpenBackendStatusPanel(ensureBackendStatusPanelOpen)
    ensureConversationPanelOpen()

    return () => {
      registerOpenConversationPanel(null)
      registerOpenBackendStatusPanel(null)
      dockviewApi = null
      dockview.dispose()
    }
  })
</script>

<div
  bind:this={hostElement}
  class={`vide-dockview ${dockviewThemeClass} h-full min-h-0 w-full`}
></div>
