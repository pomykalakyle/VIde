import { expect, test } from 'bun:test'
import { SessionClient } from './session-client'
import {
  getAvailablePort,
  isAssistantConversationEntry,
  getFakeAssistantReply,
  isSessionSnapshotMessage,
  isUserConversationEntry,
  startSessionServer,
  stopSessionServer,
  waitForServerMessage,
} from './session-test-utils'

/** Verifies the client starts the live Bun server, submits a message, and receives the expected transcript events back. */
test(
  'session client exchanges snapshot and append events with the live Bun backend',
  async () => {
    const port = await getAvailablePort()
    const serverProcess = await startSessionServer(port)
    const client = new SessionClient({
      sessionId: 'local-dev',
      url: `ws://127.0.0.1:${port}/ws`,
    })

    try {
      const snapshotPromise = waitForServerMessage(client, isSessionSnapshotMessage)
      const userEntryPromise = waitForServerMessage(client, isUserConversationEntry)
      const assistantEntryPromise = waitForServerMessage(client, isAssistantConversationEntry)

      await client.connect()

      const snapshot = await snapshotPromise
      expect(snapshot.entries).toEqual([])

      client.submitUserMessage('Show me the shell and the transcript first.')

      const userEntry = await userEntryPromise
      const assistantEntry = await assistantEntryPromise

      expect(userEntry.entry.content).toBe('Show me the shell and the transcript first.')
      expect(assistantEntry.entry.content).toBe(getFakeAssistantReply())
    } finally {
      client.disconnect()
      await stopSessionServer(serverProcess)
    }
  },
  120_000,
)
