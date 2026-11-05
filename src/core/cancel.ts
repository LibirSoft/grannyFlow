export class GrannyCancelled extends Error {
  constructor() {
    super('cancelled')
    this.name = 'GrannyCancelled'
  }
}

/** Matches by name too, so a bundle that carries its own copy of the class still matches. */
export const isCancelled = (e: unknown): e is GrannyCancelled =>
  e instanceof GrannyCancelled || (typeof e === 'object' && e !== null && (e as { name?: unknown }).name === 'GrannyCancelled')
