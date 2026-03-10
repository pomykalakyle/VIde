import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { app } from 'electron'

import { bootElectronApp } from './main'

/** Represents one serialized result payload emitted by the Electron integration runner. */
interface ElectronIntegrationRunnerResult {
  error?: string
  ok: boolean
  value?: unknown
}

/** Returns the required non-empty environment variable value for the integration runner. */
function getRequiredEnvironmentValue(name: string): string {
  const value = process.env[name]?.trim()

  if (!value) {
    throw new Error(`Missing required Electron integration environment variable: ${name}`)
  }

  return value
}

/** Returns whether the provided environment variable is explicitly enabled for the runner. */
function isEnabledEnvironmentFlag(name: string): boolean {
  return process.env[name] === 'true'
}

/** Returns the optional environment variable value when it is present and non-empty. */
function getOptionalEnvironmentValue(name: string): string | null {
  const value = process.env[name]?.trim()
  return value && value.length > 0 ? value : null
}

/** Returns the minimal HTML page used to host the preload bridge during integration tests. */
function createIntegrationRendererHtml(): string {
  return [
    '<!doctype html>',
    '<html lang="en">',
    '  <head>',
    '    <meta charset="utf-8" />',
    '    <title>VIde Integration Runner</title>',
    '  </head>',
    '  <body>',
    '    <main id="app">integration-runner</main>',
    '  </body>',
    '</html>',
  ].join('')
}

/** Writes one JSON result file for the parent Bun integration test process. */
async function writeIntegrationRunnerResult(
  resultPath: string,
  result: ElectronIntegrationRunnerResult,
): Promise<void> {
  await mkdir(path.dirname(resultPath), { recursive: true })
  await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8')
}

/** Runs one renderer-side script through the real preload and IPC bridge. */
async function main(): Promise<void> {
  const resultPath = getRequiredEnvironmentValue('VIDE_TEST_RESULT_FILE')
  const rendererScript = getRequiredEnvironmentValue('VIDE_TEST_RENDERER_SCRIPT')
  const rendererUrl = getOptionalEnvironmentValue('VIDE_TEST_RENDERER_URL')
  const useRealRenderer = isEnabledEnvironmentFlag('VIDE_TEST_USE_REAL_RENDERER')

  try {
    const window = useRealRenderer
      ? await bootElectronApp(rendererUrl ? { rendererUrl } : {})
      : await bootElectronApp({
          rendererHtml: createIntegrationRendererHtml(),
        })
    const value = await window.webContents.executeJavaScript(rendererScript, true)

    await writeIntegrationRunnerResult(resultPath, {
      ok: true,
      value,
    })
    app.exit(0)
  } catch (error) {
    await writeIntegrationRunnerResult(resultPath, {
      error:
        error instanceof Error ? error.message : 'The Electron integration runner encountered an error.',
      ok: false,
    })
    app.exit(1)
  }
}

void main().catch((error) => {
  console.error(
    error instanceof Error ? error.message : 'The Electron integration runner failed unexpectedly.',
  )
  app.exit(1)
})
