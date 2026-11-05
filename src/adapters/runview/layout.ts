// The run view's page as rows of tone-coloured cells, shared by the omp and opencode navigators.

export type Tone = 'base' | 'muted' | 'success' | 'error' | 'warning' | 'info'

export interface Cell {
  text: string
  tone: Tone
  selected?: boolean
}
