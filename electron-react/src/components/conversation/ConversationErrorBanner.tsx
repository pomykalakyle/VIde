/** Represents the props for the live conversation error banner. */
interface ConversationErrorBannerProps {
  message: string
  onDismiss: () => void
}

/** Renders the dismissible chat error banner above the transcript. */
export function ConversationErrorBanner({
  message,
  onDismiss,
}: ConversationErrorBannerProps): JSX.Element {
  return (
    <div className="rounded-2xl border border-rose-500/30 bg-rose-500/12 px-4 py-3 text-sm text-rose-200">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p>{message}</p>
        <button
          type="button"
          className="rounded-xl border border-rose-400/30 px-3 py-2 text-sm font-medium text-rose-100 transition hover:border-rose-300/50"
          onClick={onDismiss}
        >
          Dismiss
        </button>
      </div>
    </div>
  )
}
