/**
 * WikiWatcher — chokidar-based file watcher for the WK pipeline wiki root.
 * Mirrors the kb-watcher pattern (stability threshold, awaitWriteFinish).
 * On any add/change/unlink under the root, calls the ingester.
 */
import chokidar, { type FSWatcher } from 'chokidar'

import type { WikiIngester } from './wiki-ingester.js'

export interface WikiWatcherOptions {
  root: string
  ingester: WikiIngester
  stabilityThreshold?: number
  pollInterval?: number
  depth?: number
}

export class WikiWatcher {
  private watcher: FSWatcher | null = null
  constructor(private opts: WikiWatcherOptions) {}

  async start(): Promise<void> {
    if (this.watcher) return
    const w = chokidar.watch(this.opts.root, {
      ignored: /(^|[\\/])(\.[^\\/]|graphify-out|node_modules)/,
      ignoreInitial: true, // initial walk is handled by ingester.ingestAll()
      persistent: true,
      depth: this.opts.depth ?? 8,
      awaitWriteFinish: {
        stabilityThreshold: this.opts.stabilityThreshold ?? 100,
        pollInterval: this.opts.pollInterval ?? 50,
      },
    })
    w.on('add', (p) => { if (p.endsWith('.md')) this.opts.ingester.ingestFile(p) })
    w.on('change', (p) => { if (p.endsWith('.md')) this.opts.ingester.ingestFile(p) })
    w.on('unlink', (p) => { if (p.endsWith('.md')) this.opts.ingester.removeFile(p) })
    w.on('error', (err) => { console.error('[wiki-watcher] error:', err) })
    await new Promise<void>((resolve) => { w.on('ready', () => resolve()) })
    this.watcher = w
  }

  async stop(): Promise<void> {
    if (!this.watcher) return
    await this.watcher.close()
    this.watcher = null
  }
}
