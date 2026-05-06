import '@testing-library/jest-dom/vitest'

// Node 25 ships an experimental localStorage that conflicts with jsdom's.
// Force-define a fresh in-memory localStorage on the window so tests can
// .clear() / .setItem() / .getItem() reliably.
class MemStorage implements Storage {
  private map = new Map<string, string>()
  get length(): number { return this.map.size }
  clear(): void { this.map.clear() }
  getItem(key: string): string | null { return this.map.get(key) ?? null }
  key(i: number): string | null { return [...this.map.keys()][i] ?? null }
  removeItem(key: string): void { this.map.delete(key) }
  setItem(key: string, value: string): void { this.map.set(key, String(value)) }
}

Object.defineProperty(window, 'localStorage', {
  value: new MemStorage(),
  writable: false,
  configurable: true,
})
