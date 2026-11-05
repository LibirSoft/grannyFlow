// The parts of opencode's TUI runtime the granny TUI plugin uses; opencode provides the modules.
declare module '@opentui/solid' {
  export function createElement(tag: string): any
  export function createTextNode(value: string): any
  export function insertNode(parent: any, node: any, anchor?: any): void
  export function insert(parent: any, accessor: any, marker?: any, initial?: any): any
  export function setProp(node: any, name: string, value: any, prev?: any): any
  export function useTerminalDimensions(): () => { width: number; height: number }
}

declare module 'solid-js' {
  export function createSignal<T>(value: T, options?: { name?: string; equals?: false | ((prev: T, next: T) => boolean) }): [() => T, (next: T | ((prev: T) => T)) => T]
  export function onCleanup(fn: () => void): () => void
}
