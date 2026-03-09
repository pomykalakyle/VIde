import { useEffect } from 'react'

import { WorkspaceShell } from './components/workspace/WorkspaceShell'

/** Renders the root React workspace for the parallel Electron app. */
export function App(): JSX.Element {
  useEffect(() => {
    document.title = 'VIde'
  }, [])

  return <WorkspaceShell />
}

export default App
