import type { RenderedConversationEntry } from '../../lib/types/session'

/** Represents the props for one rendered conversation message. */
interface ConversationMessageProps {
  entry: RenderedConversationEntry
}

/** Renders one user or assistant message inside the transcript. */
export function ConversationMessage({ entry }: ConversationMessageProps): JSX.Element {
  const isUserMessage = entry.role === 'user'
  const isErrorMessage = entry.status === 'error'

  return (
    <div className={`flex ${isUserMessage ? 'justify-end' : 'justify-start'}`}>
      <article
        className={`w-full max-w-[85%] rounded-2xl border px-4 py-3 shadow-sm ${
          isUserMessage
            ? 'border-[var(--color-accent)]/20 bg-[var(--color-accent)]/10'
            : isErrorMessage
              ? 'border-rose-500/30 bg-rose-500/12'
              : 'border-[var(--color-border)] bg-[var(--color-bg)]/90'
        }`}
      >
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <span
            className={`text-[11px] font-semibold uppercase tracking-[0.12em] ${
              isUserMessage ? 'text-[var(--color-accent)]' : 'text-[var(--color-muted)]'
            }`}
          >
            {isUserMessage ? 'You' : 'VIde'}
          </span>
          {isErrorMessage ? (
            <span className="rounded-full border border-rose-500/30 bg-rose-500/12 px-2 py-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-rose-200">
              Error
            </span>
          ) : null}
        </div>
        <p
          className={`whitespace-pre-wrap text-sm leading-6 ${
            isErrorMessage ? 'text-rose-100' : 'text-[var(--color-text)]'
          }`}
        >
          {entry.content}
        </p>
      </article>
    </div>
  )
}
