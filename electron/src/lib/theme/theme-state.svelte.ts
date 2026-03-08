import { isThemeName, type ThemeDefinition, type ThemeName, themes } from './themes'

const storageKey = 'vide.theme'
const defaultTheme: ThemeName = 'graphite'

/** Applies the selected theme colors to the document root. */
function applyTheme(themeName: ThemeName): void {
  if (typeof document === 'undefined') {
    return
  }

  const theme = themes[themeName]
  const root = document.documentElement

  root.dataset.theme = themeName

  for (const [token, value] of Object.entries(theme) as [keyof ThemeDefinition, string][]) {
    root.style.setProperty(`--color-${token}`, value)
  }
}

/** Reads the persisted theme preset from local storage. */
function readStoredTheme(): ThemeName {
  if (typeof window === 'undefined') {
    return defaultTheme
  }

  const value = window.localStorage.getItem(storageKey)
  return value && isThemeName(value) ? value : defaultTheme
}

/** Stores the active UI theme and persists changes to local storage. */
class ThemeState {
  current = $state<ThemeName>(readStoredTheme())

  constructor() {
    applyTheme(this.current)
  }

  /** Replaces the current theme and applies it to the document. */
  set(themeName: ThemeName): void {
    this.current = themeName
    applyTheme(themeName)

    if (typeof window !== 'undefined') {
      window.localStorage.setItem(storageKey, themeName)
    }
  }
}

/** Stores the currently selected theme preset. */
export const theme = new ThemeState()
