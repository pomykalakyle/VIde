/** Represents the props for the live conversation header. */
interface ConversationHeaderProps {
  connectionStatus: 'connecting' | 'connected' | 'disconnected'
}

/** Returns the badge label for the current chat socket connection state. */
function getConnectionStatusLabel(status: ConversationHeaderProps['connectionStatus']): string {
  if (status === 'connected') {
    return 'Connected'
  }

  if (status === 'disconnected') {
    return 'Disconnected'
  }

  return 'Connecting'
}

/** Returns the badge classes for the current chat socket connection state. */
function getConnectionStatusTone(status: ConversationHeaderProps['connectionStatus']): string {
  if (status === 'connected') {
    return 'border-emerald-500/30 bg-emerald-500/12 text-emerald-300'
  }

  if (status === 'disconnected') {
    return 'border-rose-500/30 bg-rose-500/12 text-rose-200'
  }

  return 'border-sky-500/30 bg-sky-500/12 text-sky-300'
}

/** Renders the live chat header and its transcript controls. */
export function ConversationHeader({
  connectionStatus,
}: ConversationHeaderProps): JSX.Element {
  return (
    <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-panel)] p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-base font-semibold">Chat</h2>
        <span
          className={`rounded-full border px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.12em] ${getConnectionStatusTone(connectionStatus)}`}
        >
          {getConnectionStatusLabel(connectionStatus)}
        </span>
      </div>
    </div>
  )
}
