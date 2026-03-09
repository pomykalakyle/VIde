import { getServerPort } from './config'
import { startServer } from './lib'

/** Starts the minimal Bun backend on the configured local socket. */
function main(): void {
  const port = getServerPort()
  const handle = startServer({ port })

  /** Stops the running Bun backend before the process exits. */
  const stop = () => {
    void handle.stop()
  }

  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
}

main()
