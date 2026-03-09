/** Represents the props for the conversation composer. */
interface ConversationComposerProps {
  canSend: boolean
  connectionStatus: 'connecting' | 'connected' | 'disconnected'
  value: string
  isSending: boolean
  onClearChat: () => void
  onReconnect: () => void
  onSubmit: () => void
  onValueChange: (value: string) => void
}

/** Renders the bottom-anchored text composer for the live chat session. */
export function ConversationComposer({
  canSend,
  connectionStatus,
  value,
  isSending,
  onClearChat,
  onReconnect,
  onSubmit,
  onValueChange,
}: ConversationComposerProps): JSX.Element {
  return (
    <form
      className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-panel)] p-4"
      onSubmit={(event) => {
        event.preventDefault()
        onSubmit()
      }}
    >
      <label
        htmlFor="conversation-pane-composer"
        className="text-xs font-semibold uppercase tracking-[0.12em] text-[var(--color-muted)]"
      >
        Message
      </label>
      <textarea
        id="conversation-pane-composer"
        value={value}
        onChange={(event) => {
          onValueChange(event.target.value)
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault()
            onSubmit()
          }
        }}
        placeholder="Ask the agent to inspect something, explain a file, or sketch a UI tweak..."
        className="mt-3 min-h-28 w-full resize-none rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg)] px-4 py-3 text-sm leading-6 text-[var(--color-text)] outline-none transition placeholder:text-[var(--color-muted)] focus:border-[var(--color-accent)]"
      />
      <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap items-center gap-3">
          {connectionStatus !== 'connected' ? (
            <button
              type="button"
              className="text-sm font-medium text-[var(--color-muted)] transition hover:text-[var(--color-text)]"
              onClick={onReconnect}
            >
              Reconnect
            </button>
          ) : null}
          <button
            type="button"
            className="text-sm font-medium text-[var(--color-muted)] transition hover:text-[var(--color-text)]"
            onClick={onClearChat}
          >
            Clear chat
          </button>
        </div>
        <div className="flex items-center gap-3">
          <p className="text-xs leading-5 text-[var(--color-muted)]">Enter to send</p>
          <button
            type="submit"
            className="rounded-xl border border-[var(--color-accent)]/40 bg-[var(--color-accent)]/15 px-4 py-2 text-sm font-medium text-[var(--color-text)] transition hover:border-[var(--color-accent)] disabled:cursor-not-allowed disabled:opacity-50"
            disabled={!canSend || isSending || value.trim().length === 0}
          >
            {isSending ? 'Sending...' : 'Send'}
          </button>
        </div>
      </div>
    </form>
  )
}
