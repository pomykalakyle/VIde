import type { RefObject } from 'react'

import type { RenderedConversationEntry } from '../../lib/types/session'
import { ConversationMessage } from './ConversationMessage'

/** Represents the props for the conversation transcript view. */
interface ConversationTranscriptProps {
  entries: RenderedConversationEntry[]
  endRef: RefObject<HTMLDivElement | null>
}

/** Renders the scrollable transcript area for the live chat session. */
export function ConversationTranscript({
  entries,
  endRef,
}: ConversationTranscriptProps): JSX.Element {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-panel)]">
      <div className="border-b border-[var(--color-border)] px-4 py-3">
        <div className="flex justify-end">
          <div className="rounded-full border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-1 text-xs font-medium text-[var(--color-muted)]">
            {entries.length} message{entries.length === 1 ? '' : 's'}
          </div>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5">
        {entries.length === 0 ? (
          <div className="flex h-full min-h-[220px] items-center justify-center">
            <div className="max-w-md rounded-2xl border border-dashed border-[var(--color-border)] bg-[var(--color-bg)]/70 p-6 text-center">
              <h3 className="text-base font-semibold">No messages yet</h3>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            {entries.map((entry) => (
              <ConversationMessage key={entry.id} entry={entry} />
            ))}
            <div ref={endRef} />
          </div>
        )}
      </div>
    </div>
  )
}
