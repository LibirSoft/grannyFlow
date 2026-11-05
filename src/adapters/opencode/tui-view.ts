// Builds the TUI plugin's nodes with the universal-renderer functions of @opentui/solid, injected so
// that bun test can run the views against a fake. Every accessor is guarded: a failing one shows nothing.
import type { Line, Tone } from './runwatch'

export interface UiRuntime {
  createElement(tag: string): any
  createTextNode(value: string): any
  insertNode(parent: any, node: any, anchor?: any): void
  insert(parent: any, accessor: any, marker?: any, initial?: any): any
  setProp(node: any, name: string, value: any, prev?: any): any
  useTerminalDimensions?(): () => { width: number; height: number }
}

export interface SolidRuntime {
  createSignal<T>(value: T, options?: { name?: string; equals?: false | ((prev: T, next: T) => boolean) }): [() => T, (next: T | ((prev: T) => T)) => T]
  onCleanup(fn: () => void): unknown
}

export interface TuiRuntime {
  ui: UiRuntime
  solid: SolidRuntime
}

export interface Cell {
  text: string
  tone: Tone
  selected?: boolean
}

const guard = <T>(fn: () => T, fallback: T): T => {
  try {
    return fn()
  } catch {
    return fallback
  }
}

export class View {
  constructor(
    private readonly rt: TuiRuntime,
    private readonly theme: () => any,
  ) {}

  color(tone: Tone): unknown {
    return guard(() => {
      const text = this.theme()?.text
      if (tone === 'base' || tone === 'muted') return text?.[tone]
      return text?.feedback?.[tone]?.base
    }, undefined)
  }

  private selection(): unknown {
    return guard(() => this.theme()?.background?.raised?.base, undefined)
  }

  private cell(cell: Cell): any {
    const { ui } = this.rt
    const node = ui.createElement('text')
    const fg = this.color(cell.tone)
    if (fg !== undefined) ui.setProp(node, 'fg', fg)
    if (cell.selected) {
      const bg = this.selection()
      if (bg !== undefined) ui.setProp(node, 'bg', bg)
    }
    ui.setProp(node, 'wrapMode', 'none')
    ui.insertNode(node, ui.createTextNode(cell.text))
    return node
  }

  private row(cells: readonly Cell[]): any {
    const { ui } = this.rt
    const node = ui.createElement('box')
    ui.setProp(node, 'flexDirection', 'row')
    for (const cell of cells) ui.insertNode(node, this.cell(cell))
    return node
  }

  /** A column of lines, one text per line; a click anywhere on it calls `onClick`. */
  lines(accessor: () => readonly Line[], onClick?: () => void): any {
    const { ui } = this.rt
    const box = ui.createElement('box')
    ui.setProp(box, 'flexDirection', 'column')
    if (onClick)
      ui.setProp(box, 'onMouseDown', () => {
        try {
          onClick()
        } catch {}
      })
    ui.insert(box, () => guard(() => accessor().map(line => this.cell(line)), []))
    return box
  }

  /** One short line, or nothing. */
  chip(accessor: () => Cell | undefined): any {
    const { ui } = this.rt
    const box = ui.createElement('box')
    ui.setProp(box, 'flexDirection', 'row')
    ui.insert(box, () =>
      guard(() => {
        const cell = accessor()
        return cell && cell.text ? [this.cell(cell)] : []
      }, []),
    )
    return box
  }

  /** A full-screen page of rows, each row a run of cells laid side by side. */
  screen(accessor: () => readonly (readonly Cell[])[]): any {
    const { ui } = this.rt
    const box = ui.createElement('box')
    ui.setProp(box, 'flexDirection', 'column')
    ui.setProp(box, 'width', '100%')
    ui.setProp(box, 'height', '100%')
    const bg = guard(() => this.theme()?.background?.base, undefined)
    if (bg !== undefined) ui.setProp(box, 'backgroundColor', bg)
    ui.insert(box, () => guard(() => accessor().map(cells => this.row(cells)), []))
    return box
  }
}
