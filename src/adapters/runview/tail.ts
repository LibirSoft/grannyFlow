// Reads a growing file from where the last read stopped, in bounded chunks, returning whole lines.
import { closeSync, openSync, readSync, statSync } from 'node:fs'

export interface TailOptions {
  firstWindowBytes?: number
  maxReadBytes?: number
}

export interface TailPoll {
  lines: string[]
  reset: boolean
  skippedBytes: number
}

const MB = 1024 * 1024
const NEWLINE = 0x0a

export class TailReader {
  private position = 0
  private read = 0
  private started = false
  private dropping = false
  private inode?: number
  private pending: Buffer = Buffer.alloc(0)
  private readonly firstWindowBytes: number
  private readonly maxReadBytes: number

  constructor(
    readonly path: string,
    { firstWindowBytes = 8 * MB, maxReadBytes = 4 * MB }: TailOptions = {},
  ) {
    this.firstWindowBytes = firstWindowBytes
    this.maxReadBytes = Math.max(1, maxReadBytes)
  }

  get offset(): number {
    return this.position
  }

  get bytesRead(): number {
    return this.read
  }

  poll(): TailPoll {
    const out: TailPoll = { lines: [], reset: false, skippedBytes: 0 }
    let size: number
    let inode: number
    try {
      const st = statSync(this.path)
      if (!st.isFile()) return out
      size = st.size
      inode = st.ino
    } catch {
      return out
    }
    if (this.started && (size < this.position || (this.inode !== undefined && inode !== this.inode))) {
      this.position = 0
      this.pending = Buffer.alloc(0)
      this.started = false
      this.dropping = false
      out.reset = true
    }
    this.inode = inode
    if (!this.started) {
      this.started = true
      if (size > this.firstWindowBytes) {
        this.position = size - this.firstWindowBytes
        this.dropping = true
        out.skippedBytes = this.position
      }
    }
    if (size === this.position) return out
    const length = Math.min(size - this.position, this.maxReadBytes)
    const chunk = Buffer.alloc(length)
    let got = 0
    let fd: number | undefined
    try {
      fd = openSync(this.path, 'r')
      got = readSync(fd, chunk, 0, length, this.position)
    } catch {
      return out
    } finally {
      if (fd !== undefined) {
        try {
          closeSync(fd)
        } catch {}
      }
    }
    if (got <= 0) return out
    this.position += got
    this.read += got
    let data = chunk.subarray(0, got)
    if (this.dropping) {
      const nl = data.indexOf(NEWLINE)
      if (nl < 0) {
        out.skippedBytes += got
        return out
      }
      out.skippedBytes += nl + 1
      data = data.subarray(nl + 1)
      this.dropping = false
    }
    const all = this.pending.length ? Buffer.concat([this.pending, data]) : data
    const last = all.lastIndexOf(NEWLINE)
    if (last < 0) {
      this.pending = Buffer.from(all)
      return out
    }
    this.pending = Buffer.from(all.subarray(last + 1))
    out.lines = all.subarray(0, last).toString('utf8').split('\n')
    return out
  }
}
