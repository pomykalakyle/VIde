import { useCallback, useEffect, useMemo, useState } from 'react'

import type { OpenAiConfigSummary } from '../../lib/types/openai-config'

type PendingAction =
  | 'apply'
  | 'clear'
  | 'convert-to-encrypted'
  | 'convert-to-plaintext'
  | 'load'
  | 'save'
  | 'unlock'
  | null

/** Returns one short label for whether the Bun runtime is ready to apply auth. */
function getRuntimeAvailabilityLabel(summary: OpenAiConfigSummary | null): string {
  if (!summary) {
    return 'Loading'
  }

  return summary.runtimeAvailable ? 'Available' : 'Unavailable'
}

/** Returns one short label for whether the current runtime matches the saved key revision. */
function getApplyStatusLabel(summary: OpenAiConfigSummary | null): string {
  if (!summary) {
    return 'Loading'
  }

  return summary.needsApply ? 'Needs apply' : 'In sync'
}

/** Returns the message shown for the current pending settings-window action. */
function getPendingActionLabel(action: PendingAction): string {
  if (action === 'apply') {
    return 'Applying saved key to OpenCode...'
  }

  if (action === 'clear') {
    return 'Clearing saved OpenAI key...'
  }

  if (action === 'convert-to-encrypted') {
    return 'Switching to encrypted storage...'
  }

  if (action === 'convert-to-plaintext') {
    return 'Switching to plaintext storage...'
  }

  if (action === 'load') {
    return 'Loading OpenAI settings...'
  }

  if (action === 'save') {
    return 'Saving OpenAI key...'
  }

  if (action === 'unlock') {
    return 'Unlocking encrypted store...'
  }

  return ''
}

/** Renders one compact label-value row inside the dedicated settings window. */
function SummaryRow({
  label,
  value,
}: {
  label: string
  value: string
}): JSX.Element {
  return (
    <div className="flex items-start justify-between gap-4 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] px-4 py-3">
      <p className="text-xs font-semibold uppercase tracking-[0.12em] text-[var(--color-muted)]">
        {label}
      </p>
      <p className="max-w-[65%] text-right text-sm text-[var(--color-text)]">{value}</p>
    </div>
  )
}

/** Renders the dedicated settings window used to manage persisted OpenAI credentials. */
export function OpenAiSettingsWindow(): JSX.Element {
  const [summary, setSummary] = useState<OpenAiConfigSummary | null>(null)
  const [pendingAction, setPendingAction] = useState<PendingAction>('load')
  const [errorMessage, setErrorMessage] = useState('')
  const [successMessage, setSuccessMessage] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [unlockPassphrase, setUnlockPassphrase] = useState('')
  const [encryptPassphrase, setEncryptPassphrase] = useState('')
  const [plaintextPassphrase, setPlaintextPassphrase] = useState('')

  /** Loads the latest OpenAI runtime-config summary into the settings window. */
  const loadSummary = useCallback(async (): Promise<void> => {
    setPendingAction('load')

    try {
      setSummary(await window.videApi.getOpenAiConfigSummary())
      setErrorMessage('')
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'The settings could not be loaded.')
    } finally {
      setPendingAction(null)
    }
  }, [])

  useEffect(() => {
    void loadSummary()
  }, [loadSummary])

  /** Stores the latest summary and optional success message after one API mutation. */
  const applySummaryUpdate = useCallback(
    (nextSummary: OpenAiConfigSummary, nextSuccessMessage: string): void => {
      setSummary(nextSummary)
      setErrorMessage('')
      setSuccessMessage(nextSuccessMessage)
    },
    [],
  )

  /** Saves the current API key input into the Bun-owned OpenAI config store. */
  const handleSave = useCallback(async (): Promise<void> => {
    setPendingAction('save')

    try {
      applySummaryUpdate(
        await window.videApi.saveOpenAiConfig({ apiKey }),
        'The OpenAI key was saved to disk.',
      )
      setApiKey('')
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'The OpenAI key could not be saved.')
      setSuccessMessage('')
    } finally {
      setPendingAction(null)
    }
  }, [apiKey, applySummaryUpdate])

  /** Clears the saved OpenAI key from disk without mutating the live runtime. */
  const handleClear = useCallback(async (): Promise<void> => {
    setPendingAction('clear')

    try {
      applySummaryUpdate(await window.videApi.clearOpenAiConfig(), 'The saved OpenAI key was cleared.')
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'The OpenAI key could not be cleared.')
      setSuccessMessage('')
    } finally {
      setPendingAction(null)
    }
  }, [applySummaryUpdate])

  /** Unlocks the encrypted OpenAI key store for the current Bun process. */
  const handleUnlock = useCallback(async (): Promise<void> => {
    setPendingAction('unlock')

    try {
      applySummaryUpdate(
        await window.videApi.unlockOpenAiConfig({ passphrase: unlockPassphrase }),
        'The encrypted OpenAI key store was unlocked.',
      )
      setUnlockPassphrase('')
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : 'The encrypted store could not be unlocked.',
      )
      setSuccessMessage('')
    } finally {
      setPendingAction(null)
    }
  }, [applySummaryUpdate, unlockPassphrase])

  /** Converts the local OpenAI key store from plaintext into encrypted storage. */
  const handleConvertToEncrypted = useCallback(async (): Promise<void> => {
    setPendingAction('convert-to-encrypted')

    try {
      applySummaryUpdate(
        await window.videApi.convertOpenAiConfig({
          newPassphrase: encryptPassphrase,
          targetMode: 'encrypted',
        }),
        'The OpenAI key store now uses encrypted storage.',
      )
      setEncryptPassphrase('')
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : 'The store could not be converted to encrypted mode.',
      )
      setSuccessMessage('')
    } finally {
      setPendingAction(null)
    }
  }, [applySummaryUpdate, encryptPassphrase])

  /** Converts the local OpenAI key store from encrypted into plaintext storage. */
  const handleConvertToPlaintext = useCallback(async (): Promise<void> => {
    setPendingAction('convert-to-plaintext')

    try {
      applySummaryUpdate(
        await window.videApi.convertOpenAiConfig({
          currentPassphrase: plaintextPassphrase || undefined,
          targetMode: 'plaintext',
        }),
        'The OpenAI key store now uses plaintext storage.',
      )
      setPlaintextPassphrase('')
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : 'The store could not be converted to plaintext mode.',
      )
      setSuccessMessage('')
    } finally {
      setPendingAction(null)
    }
  }, [applySummaryUpdate, plaintextPassphrase])

  /** Applies the latest saved OpenAI key revision into the running OpenCode runtime. */
  const handleApply = useCallback(async (): Promise<void> => {
    setPendingAction('apply')

    try {
      applySummaryUpdate(
        await window.videApi.applyOpenAiConfig(),
        'The running OpenCode runtime now matches the saved key.',
      )
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'The saved key could not be applied.')
      setSuccessMessage('')
    } finally {
      setPendingAction(null)
    }
  }, [applySummaryUpdate])

  const isBusy = pendingAction !== null
  const runtimeApplyButtonLabel = useMemo(() => {
    if (summary?.needsApply) {
      return 'Apply saved key'
    }

    return 'Runtime already in sync'
  }, [summary?.needsApply])

  return (
    <main className="flex h-full min-h-0 flex-col overflow-y-auto bg-[var(--color-bg)] text-[var(--color-text)]">
      <section className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-6 py-6">
        <header className="rounded-3xl border border-[var(--color-border)] bg-[var(--color-panel)] px-6 py-5">
          <p className="text-xs font-semibold uppercase tracking-[0.12em] text-[var(--color-accent)]">
            Settings
          </p>
          <h1 className="mt-2 text-2xl font-semibold">OpenAI Credentials</h1>
          <p className="mt-2 max-w-2xl text-sm text-[var(--color-muted)]">
            Save the OpenAI key to disk, choose plaintext or encrypted storage, and apply the
            latest saved revision to the running OpenCode runtime when needed.
          </p>
        </header>

        <section className="grid gap-3 md:grid-cols-2">
          <SummaryRow
            label="Storage mode"
            value={summary?.secretStorageMode === 'encrypted' ? 'Encrypted' : 'Plaintext'}
          />
          <SummaryRow label="Saved key" value={summary?.hasOpenAIKey ? 'Configured' : 'Missing'} />
          <SummaryRow label="Runtime" value={getRuntimeAvailabilityLabel(summary)} />
          <SummaryRow label="Apply status" value={getApplyStatusLabel(summary)} />
          <SummaryRow label="Default model" value={summary?.defaultModel ?? 'Loading'} />
          <SummaryRow
            label="Last applied revision"
            value={
              summary?.lastAppliedSavedRevision === null ||
              summary?.lastAppliedSavedRevision === undefined
                ? 'Never'
                : String(summary.lastAppliedSavedRevision)
            }
          />
        </section>

        <section className="rounded-3xl border border-[var(--color-border)] bg-[var(--color-panel)] p-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-base font-semibold">Save key</h2>
              <p className="mt-1 text-sm text-[var(--color-muted)]">
                Saving updates the on-disk revision only. Use Apply to reconcile the live OpenCode
                runtime afterward.
              </p>
            </div>
            <button
              type="button"
              className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] px-4 py-2 text-sm font-medium text-[var(--color-text)] transition hover:border-[var(--color-accent)]"
              onClick={() => void loadSummary()}
            >
              Refresh
            </button>
          </div>

          <label className="mt-5 flex flex-col gap-2 text-sm">
            <span className="text-[var(--color-muted)]">OpenAI API key</span>
            <input
              type="password"
              className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg)] px-4 py-3 text-[var(--color-text)] outline-none transition focus:border-[var(--color-accent)]"
              placeholder="sk-..."
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
            />
          </label>

          <div className="mt-4 flex flex-wrap gap-3">
            <button
              type="button"
              className="rounded-xl border border-[var(--color-accent)] bg-[var(--color-accent)] px-4 py-2 text-sm font-semibold text-black transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
              onClick={() => void handleSave()}
              disabled={isBusy || apiKey.trim().length === 0}
            >
              Save key
            </button>
            <button
              type="button"
              className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] px-4 py-2 text-sm font-medium text-[var(--color-text)] transition hover:border-rose-500 disabled:cursor-not-allowed disabled:opacity-50"
              onClick={() => void handleClear()}
              disabled={isBusy || !summary?.hasOpenAIKey}
            >
              Clear saved key
            </button>
          </div>
        </section>

        {summary?.secretStorageMode === 'encrypted' && summary.locked ? (
          <section className="rounded-3xl border border-[var(--color-border)] bg-[var(--color-panel)] p-6">
            <h2 className="text-base font-semibold">Unlock encrypted store</h2>
            <p className="mt-1 text-sm text-[var(--color-muted)]">
              Unlocking keeps the encrypted store usable for this Bun process until the backend
              restarts.
            </p>
            <label className="mt-5 flex flex-col gap-2 text-sm">
              <span className="text-[var(--color-muted)]">Passphrase</span>
              <input
                type="password"
                className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg)] px-4 py-3 text-[var(--color-text)] outline-none transition focus:border-[var(--color-accent)]"
                value={unlockPassphrase}
                onChange={(event) => setUnlockPassphrase(event.target.value)}
              />
            </label>
            <button
              type="button"
              className="mt-4 rounded-xl border border-[var(--color-accent)] bg-[var(--color-accent)] px-4 py-2 text-sm font-semibold text-black transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
              onClick={() => void handleUnlock()}
              disabled={isBusy || unlockPassphrase.trim().length === 0}
            >
              Unlock
            </button>
          </section>
        ) : null}

        <section className="rounded-3xl border border-[var(--color-border)] bg-[var(--color-panel)] p-6">
          <h2 className="text-base font-semibold">Storage mode</h2>
          <p className="mt-1 text-sm text-[var(--color-muted)]">
            Plaintext is easier to inspect. Encrypted mode keeps the key on disk behind a
            passphrase and requires unlock before edits.
          </p>

          {summary?.secretStorageMode === 'plaintext' ? (
            <div className="mt-5 flex flex-col gap-3">
              <label className="flex flex-col gap-2 text-sm">
                <span className="text-[var(--color-muted)]">New encryption passphrase</span>
                <input
                  type="password"
                  className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg)] px-4 py-3 text-[var(--color-text)] outline-none transition focus:border-[var(--color-accent)]"
                  value={encryptPassphrase}
                  onChange={(event) => setEncryptPassphrase(event.target.value)}
                />
              </label>
              <button
                type="button"
                className="self-start rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] px-4 py-2 text-sm font-medium text-[var(--color-text)] transition hover:border-[var(--color-accent)] disabled:cursor-not-allowed disabled:opacity-50"
                onClick={() => void handleConvertToEncrypted()}
                disabled={isBusy || encryptPassphrase.trim().length === 0}
              >
                Switch to encrypted
              </button>
            </div>
          ) : (
            <div className="mt-5 flex flex-col gap-3">
              <label className="flex flex-col gap-2 text-sm">
                <span className="text-[var(--color-muted)]">
                  Current passphrase if the store is still locked
                </span>
                <input
                  type="password"
                  className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg)] px-4 py-3 text-[var(--color-text)] outline-none transition focus:border-[var(--color-accent)]"
                  value={plaintextPassphrase}
                  onChange={(event) => setPlaintextPassphrase(event.target.value)}
                />
              </label>
              <button
                type="button"
                className="self-start rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] px-4 py-2 text-sm font-medium text-[var(--color-text)] transition hover:border-[var(--color-accent)] disabled:cursor-not-allowed disabled:opacity-50"
                onClick={() => void handleConvertToPlaintext()}
                disabled={isBusy}
              >
                Switch to plaintext
              </button>
            </div>
          )}
        </section>

        <section className="rounded-3xl border border-[var(--color-border)] bg-[var(--color-panel)] p-6">
          <h2 className="text-base font-semibold">Runtime apply</h2>
          <p className="mt-1 text-sm text-[var(--color-muted)]">
            Applying updates the live OpenCode runtime. Saving alone only updates the on-disk
            revision managed by Bun.
          </p>
          <button
            type="button"
            className="mt-5 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] px-4 py-2 text-sm font-medium text-[var(--color-text)] transition hover:border-[var(--color-accent)] disabled:cursor-not-allowed disabled:opacity-50"
            onClick={() => void handleApply()}
            disabled={isBusy || !summary?.runtimeAvailable || !summary?.needsApply}
          >
            {runtimeApplyButtonLabel}
          </button>
        </section>

        {pendingAction ? (
          <div className="rounded-2xl border border-sky-500/30 bg-sky-500/12 px-4 py-3 text-sm text-sky-200">
            {getPendingActionLabel(pendingAction)}
          </div>
        ) : null}

        {successMessage ? (
          <div className="rounded-2xl border border-emerald-500/30 bg-emerald-500/12 px-4 py-3 text-sm text-emerald-200">
            {successMessage}
          </div>
        ) : null}

        {summary?.applyError ? (
          <div className="rounded-2xl border border-amber-500/30 bg-amber-500/12 px-4 py-3 text-sm text-amber-200">
            {summary.applyError}
          </div>
        ) : null}

        {errorMessage ? (
          <div className="rounded-2xl border border-rose-500/30 bg-rose-500/12 px-4 py-3 text-sm text-rose-200">
            {errorMessage}
          </div>
        ) : null}
      </section>
    </main>
  )
}
