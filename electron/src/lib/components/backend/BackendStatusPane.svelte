<svelte:options runes={true} />

<script lang="ts">
  import {
    backendStatusState,
    type BackendHealthStatus,
  } from '../../session/backend-status-state.svelte'
  import { getDefaultSessionServerUrl } from '../../session/session-client'
  import { sessionState } from '../../session/session-state.svelte'
  import type { SessionConnectionStatus } from '../../types/session'

  const backendStatus = backendStatusState
  const session = sessionState
  const sessionEndpoint = getDefaultSessionServerUrl()

  let backendHealthLabel = $derived(getBackendHealthLabel(backendStatus.healthStatus))
  let backendHealthTone = $derived(getBackendHealthTone(backendStatus.healthStatus))
  let sessionConnectionLabel = $derived(getSessionConnectionLabel(session.connectionStatus))
  let sessionConnectionTone = $derived(getSessionConnectionTone(session.connectionStatus))
  let lastCheckedLabel = $derived(formatLastCheckedAt(backendStatus.lastCheckedAt))

  /** Returns the human-readable label for one backend health state. */
  function getBackendHealthLabel(status: BackendHealthStatus): string {
    if (status === 'healthy') {
      return 'Healthy'
    }

    if (status === 'unreachable') {
      return 'Unreachable'
    }

    if (status === 'checking') {
      return 'Checking'
    }

    return 'Idle'
  }

  /** Returns the badge classes for one backend health state. */
  function getBackendHealthTone(status: BackendHealthStatus): string {
    if (status === 'healthy') {
      return 'border-emerald-500/30 bg-emerald-500/12 text-emerald-300'
    }

    if (status === 'unreachable') {
      return 'border-rose-500/30 bg-rose-500/12 text-rose-300'
    }

    if (status === 'checking') {
      return 'border-sky-500/30 bg-sky-500/12 text-sky-300'
    }

    return 'border-[var(--color-border)] bg-[var(--color-panel)] text-[var(--color-muted)]'
  }

  /** Returns the human-readable label for one session connection state. */
  function getSessionConnectionLabel(status: SessionConnectionStatus): string {
    if (status === 'connected') {
      return 'Connected'
    }

    if (status === 'connecting') {
      return 'Connecting'
    }

    return 'Disconnected'
  }

  /** Returns the badge classes for one session connection state. */
  function getSessionConnectionTone(status: SessionConnectionStatus): string {
    if (status === 'connected') {
      return 'border-emerald-500/30 bg-emerald-500/12 text-emerald-300'
    }

    if (status === 'connecting') {
      return 'border-sky-500/30 bg-sky-500/12 text-sky-300'
    }

    return 'border-rose-500/30 bg-rose-500/12 text-rose-300'
  }

  /** Formats one health-check timestamp for display in the panel. */
  function formatLastCheckedAt(timestamp: number | null): string {
    if (timestamp === null) {
      return 'Not checked yet'
    }

    return new Intl.DateTimeFormat(undefined, {
      hour: 'numeric',
      minute: '2-digit',
      second: '2-digit',
    }).format(timestamp)
  }

  $effect(() => {
    backendStatus.start()

    return () => {
      backendStatus.stop()
    }
  })
</script>

<section class="flex h-full min-h-0 flex-col bg-[var(--color-bg)] text-[var(--color-text)]">
  <div class="flex-1 overflow-y-auto px-4 py-6 sm:px-6">
    <div class="mx-auto flex w-full max-w-4xl flex-col gap-6">
      <div class="rounded-3xl border border-[var(--color-border)] bg-[var(--color-panel)] px-5 py-5">
        <p class="text-xs font-semibold uppercase tracking-[0.12em] text-[var(--color-accent)]">
          Backend
        </p>
        <h2 class="mt-2 text-xl font-semibold text-[var(--color-text)]">Bun Server Status</h2>
        <p class="mt-2 text-sm text-[var(--color-muted)]">
          This panel shows server reachability from the `/health` endpoint and the current session WebSocket connection state.
        </p>
      </div>

      <div class="grid gap-4 lg:grid-cols-2">
        <article class="rounded-3xl border border-[var(--color-border)] bg-[var(--color-panel)] px-5 py-5">
          <div class="flex items-start justify-between gap-3">
            <div>
              <p class="text-xs font-semibold uppercase tracking-[0.12em] text-[var(--color-muted)]">
                HTTP Health
              </p>
              <h3 class="mt-2 text-lg font-semibold text-[var(--color-text)]">Reachability</h3>
            </div>
            <span class={`inline-flex rounded-full border px-3 py-1 text-xs font-semibold uppercase tracking-[0.12em] ${backendHealthTone}`}>
              {backendHealthLabel}
            </span>
          </div>

          <dl class="mt-4 flex flex-col gap-4 text-sm">
            <div class="flex flex-col gap-1">
              <dt class="font-semibold text-[var(--color-muted)]">Health endpoint</dt>
              <dd class="break-all font-mono text-xs text-[var(--color-text)]">{backendStatus.endpoint}</dd>
            </div>
            <div class="flex flex-col gap-1">
              <dt class="font-semibold text-[var(--color-muted)]">Last checked</dt>
              <dd class="text-[var(--color-text)]">{lastCheckedLabel}</dd>
            </div>
            <div class="flex flex-col gap-1">
              <dt class="font-semibold text-[var(--color-muted)]">Latest health error</dt>
              <dd class={backendStatus.error ? 'text-rose-300' : 'text-[var(--color-muted)]'}>
                {backendStatus.error || 'None'}
              </dd>
            </div>
          </dl>
        </article>

        <article class="rounded-3xl border border-[var(--color-border)] bg-[var(--color-panel)] px-5 py-5">
          <div class="flex items-start justify-between gap-3">
            <div>
              <p class="text-xs font-semibold uppercase tracking-[0.12em] text-[var(--color-muted)]">
                Session Socket
              </p>
              <h3 class="mt-2 text-lg font-semibold text-[var(--color-text)]">Renderer Connection</h3>
            </div>
            <span class={`inline-flex rounded-full border px-3 py-1 text-xs font-semibold uppercase tracking-[0.12em] ${sessionConnectionTone}`}>
              {sessionConnectionLabel}
            </span>
          </div>

          <dl class="mt-4 flex flex-col gap-4 text-sm">
            <div class="flex flex-col gap-1">
              <dt class="font-semibold text-[var(--color-muted)]">Session id</dt>
              <dd class="text-[var(--color-text)]">{session.sessionId}</dd>
            </div>
            <div class="flex flex-col gap-1">
              <dt class="font-semibold text-[var(--color-muted)]">WebSocket endpoint</dt>
              <dd class="break-all font-mono text-xs text-[var(--color-text)]">{sessionEndpoint}</dd>
            </div>
            <div class="flex flex-col gap-1">
              <dt class="font-semibold text-[var(--color-muted)]">Latest session error</dt>
              <dd class={session.error ? 'text-rose-300' : 'text-[var(--color-muted)]'}>
                {session.error || 'None'}
              </dd>
            </div>
          </dl>
        </article>
      </div>
    </div>
  </div>
</section>
