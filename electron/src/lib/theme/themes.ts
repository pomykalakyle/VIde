/** Represents the semantic color tokens used by a UI theme. */
export interface ThemeDefinition {
  bg: string
  panel: string
  border: string
  text: string
  muted: string
  accent: string
  accentContrast: string
}

/** Represents the available theme preset names. */
export type ThemeName = (typeof themeNames)[number]

/** Lists the supported theme preset names. */
export const themeNames = ['midnight', 'graphite', 'high-contrast'] as const

/** Maps each theme preset to a human-readable label. */
export const themeLabels: Record<ThemeName, string> = {
  midnight: 'Midnight',
  graphite: 'Graphite',
  'high-contrast': 'High Contrast',
}

/** Defines the semantic colors for each supported theme preset. */
export const themes: Record<ThemeName, ThemeDefinition> = {
  midnight: {
    bg: '#020617',
    panel: '#0f172a',
    border: '#1e293b',
    text: '#e2e8f0',
    muted: '#94a3b8',
    accent: '#38bdf8',
    accentContrast: '#082f49',
  },
  graphite: {
    bg: '#111111',
    panel: '#1a1a1a',
    border: '#2f2f2f',
    text: '#f3f4f6',
    muted: '#a3a3a3',
    accent: '#f59e0b',
    accentContrast: '#1c1917',
  },
  'high-contrast': {
    bg: '#000000',
    panel: '#111111',
    border: '#ffffff',
    text: '#ffffff',
    muted: '#d4d4d8',
    accent: '#22d3ee',
    accentContrast: '#001014',
  },
}

/** Returns whether a string matches a supported theme preset. */
export function isThemeName(value: string): value is ThemeName {
  return themeNames.includes(value as ThemeName)
}
