import { getServerPort } from './config'
import { startSessionServer } from './lib'

/** Starts the Bun VIde backend on the configured local socket. */
function main(): void {
  const handle = startSessionServer({
    port: getServerPort(),
  })

  const stop = () => {
    void handle.stop()
  }

  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
}

main()
