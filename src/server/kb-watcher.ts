import chokidar, { type FSWatcher } from 'chokidar'
import path from 'node:path'

import { skillNameForPath } from './kb-browser.js'
import type { KbEventBus } from './kb-event-bus.js'
import type { KbEventKind } from '../types/kb.js'

export interface KbWatcherOptions {
  skillsDir: string
  bus: KbEventBus
  /**
   * `awaitWriteFinish.stabilityThreshold` for chokidar. Defaults to 100ms;
   * tested in spike3 to be enough to absorb tmp+rename without producing two
   * events.
   */
  stabilityThreshold?: number
  /** chokidar `pollInterval` for awaitWriteFinish. Default 50ms. */
  pollInterval?: number
  /** Cap directory traversal depth. Default 5 (room for nested skills). */
  depth?: number
}

export class KbWatcher {
  private watcher: FSWatcher | null = null
  private opts: KbWatcherOptions

  constructor(opts: KbWatcherOptions) {
    this.opts = opts
  }

  async start(): Promise<void> {
    if (this.watcher) return
    const w = chokidar.watch(this.opts.skillsDir, {
      ignored: /(^|[\\/])\.[^\\/]/, // dot-files (e.g., .swp, .DS_Store)
      ignoreInitial: false,
      persistent: true,
      depth: this.opts.depth ?? 5,
      awaitWriteFinish: {
        stabilityThreshold: this.opts.stabilityThreshold ?? 100,
        pollInterval: this.opts.pollInterval ?? 50,
      },
    })
    const emit = (kind: KbEventKind) => (absPath: string) => {
      this.opts.bus.emit({
        kind,
        path: absPath,
        skill: skillNameForPath(this.opts.skillsDir, absPath),
        ts: Date.now(),
      })
    }
    w.on('add', emit('add'))
    w.on('change', emit('change'))
    w.on('unlink', emit('unlink'))
    w.on('addDir', emit('addDir'))
    w.on('unlinkDir', emit('unlinkDir'))
    w.on('error', (err) => {
      console.error('[kb-watcher] error:', err)
    })

    await new Promise<void>((resolve) => {
      w.on('ready', () => resolve())
    })
    this.watcher = w
  }

  async stop(): Promise<void> {
    if (!this.watcher) return
    await this.watcher.close()
    this.watcher = null
  }
}
