import { getServerPort } from './config'
import { startServer } from './lib'

/** Starts the minimal Bun backend on the configured local socket. */
function main(): void {
  const port = getServerPort()
  const handle = startServer({ port })
  let isShuttingDown = false

  /** Stops the running Bun backend and exits the process once cleanup finishes. */
  const stop = (exitCode: number) => {
    if (isShuttingDown) {
      return
    }

    isShuttingDown = true
    void handle
      .stop()
      .then(() => {
        process.exit(exitCode)
      })
      .catch(() => {
        process.exit(1)
      })
  }

  process.once('SIGINT', () => {
    stop(0)
  })
  process.once('SIGTERM', () => {
    stop(0)
  })
}

main()
