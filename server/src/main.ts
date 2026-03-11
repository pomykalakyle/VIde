import { startServer } from './lib'

/** Represents the CLI startup overrides accepted by the Bun entrypoint. */
interface ServerCliOptions {
  configDirectory?: string
  port?: number
}

/** Returns the value for one CLI flag or throws when it is missing. */
function getCliOptionValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1]?.trim()

  if (!value) {
    throw new Error(`The ${flag} option requires a value.`)
  }

  return value
}

/** Returns the validated TCP port parsed from one CLI flag value. */
function parseCliPort(value: string): number {
  const port = Number(value)

  if (!Number.isInteger(port) || port <= 0) {
    throw new Error('The --port option must be a positive integer.')
  }

  return port
}

/** Returns the startup overrides parsed from the Bun process arguments. */
function parseServerCliOptions(args: string[]): ServerCliOptions {
  const options: ServerCliOptions = {}

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]

    if (!argument) {
      continue
    }

    if (argument.startsWith('--port=')) {
      options.port = parseCliPort(argument.slice('--port='.length))
      continue
    }

    if (argument === '--port') {
      options.port = parseCliPort(getCliOptionValue(args, index, '--port'))
      index += 1
      continue
    }

    if (argument.startsWith('--config-dir=')) {
      options.configDirectory = argument.slice('--config-dir='.length)
      continue
    }

    if (argument === '--config-dir') {
      options.configDirectory = getCliOptionValue(args, index, '--config-dir')
      index += 1
    }
  }

  return options
}

/** Starts the minimal Bun backend on the configured local socket. */
function main(): void {
  const handle = startServer(parseServerCliOptions(process.argv.slice(2)))
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
