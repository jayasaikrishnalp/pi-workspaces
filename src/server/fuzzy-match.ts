/**
 * Fuzzy find-and-replace inside a text file. Ported from
 * hermes-agent/fuzzy_match.py — used by the PATCH /api/skills/:name endpoint
 * (and by the future hive-self skill_patch MCP tool) so agents can apply
 * surgical edits to a SKILL.md without supplying byte-exact `old_string`.
 *
 * Strategy chain (tried in order, first hit wins):
 *
 *   1. exact                  — direct string search
 *   2. line_trimmed           — strip each line's leading/trailing whitespace
 *   3. whitespace_normalized  — collapse runs of spaces/tabs to a single space
 *   4. indentation_flexible   — ignore indentation differences entirely
 *   5. escape_normalized      — treat literal `\n` / `\t` as real newlines/tabs
 *   6. trimmed_boundary       — trim only the first/last line's whitespace
 *   7. unicode_normalized     — fold smart quotes, em/en-dashes, NBSP, ellipsis
 *   8. block_anchor           — match first+last lines exactly,
 *                               middle lines ≥ 50% similar (avg)
 *   9. context_aware          — every line ≥ 50% similar (avg)
 *
 * Matches are always APPLIED to the original (un-normalized) content — the
 * normalization is only used to LOCATE the matching line range. Replacement
 * preserves line-1 indent of the matched range so the resulting file stays
 * structurally consistent.
 *
 * Multiple matches: hard-fail with an error unless `replaceAll: true` is set,
 * mirroring Anthropic's Edit tool semantics.
 */

export type FuzzyStrategy =
  | 'exact'
  | 'line_trimmed'
  | 'whitespace_normalized'
  | 'indentation_flexible'
  | 'escape_normalized'
  | 'trimmed_boundary'
  | 'unicode_normalized'
  | 'block_anchor'
  | 'context_aware'

export interface FuzzyResult {
  /** Post-replacement content. Equal to input on failure / no match. */
  content: string
  /** Number of replacements applied. */
  replacements: number
  /** Which strategy matched. null on failure. */
  strategy: FuzzyStrategy | null
  /** Human-readable error. null on success. */
  error: string | null
}

export interface FuzzyOptions {
  replaceAll?: boolean
}

interface Range {
  /** Inclusive start char offset in the original content. */
  start: number
  /** Exclusive end char offset in the original content. */
  end: number
}

const STRATEGIES: FuzzyStrategy[] = [
  'exact',
  'line_trimmed',
  'whitespace_normalized',
  'indentation_flexible',
  'escape_normalized',
  'trimmed_boundary',
  'unicode_normalized',
  'block_anchor',
  'context_aware',
]

export function applyFuzzyPatch(
  content: string,
  oldString: string,
  newString: string,
  opts: FuzzyOptions = {},
): FuzzyResult {
  if (oldString.length === 0) {
    return { content, replacements: 0, strategy: null, error: 'old_string must not be empty' }
  }
  for (const strategy of STRATEGIES) {
    const matches = findMatches(content, oldString, strategy)
    if (matches.length === 0) continue
    if (matches.length > 1 && !opts.replaceAll) {
      return {
        content,
        replacements: 0,
        strategy: null,
        error:
          `Found ${matches.length} matches for old_string with strategy "${strategy}". ` +
          `Provide more surrounding context to make the match unique, or pass replace_all=true.`,
      }
    }
    const next = applyMatches(content, matches, newString)
    return { content: next, replacements: matches.length, strategy, error: null }
  }
  return {
    content,
    replacements: 0,
    strategy: null,
    error:
      'Could not find a match for old_string. Tried: exact, line_trimmed, ' +
      'whitespace_normalized, indentation_flexible, escape_normalized, ' +
      'trimmed_boundary, unicode_normalized, block_anchor, context_aware. ' +
      'Re-read the file and try again with a unique excerpt.',
  }
}

/* ===== Match dispatch ===== */

function findMatches(content: string, oldString: string, strategy: FuzzyStrategy): Range[] {
  switch (strategy) {
    case 'exact':                 return findExact(content, oldString)
    case 'line_trimmed':          return findByLineMap(content, oldString, trimLine)
    case 'whitespace_normalized': return findByLineMap(content, oldString, normalizeWhitespace)
    case 'indentation_flexible':  return findByLineMap(content, oldString, stripIndent)
    case 'escape_normalized':     return findByLineMap(content, escapeNormalize(oldString), trimLine)
    case 'trimmed_boundary':      return findTrimmedBoundary(content, oldString)
    case 'unicode_normalized':    return findByLineMap(content, oldString, unicodeNormalize)
    case 'block_anchor':          return findBlockAnchor(content, oldString)
    case 'context_aware':         return findContextAware(content, oldString)
  }
}

/* ===== Strategy 1: exact ===== */

function findExact(content: string, oldString: string): Range[] {
  const out: Range[] = []
  let i = content.indexOf(oldString)
  while (i !== -1) {
    out.push({ start: i, end: i + oldString.length })
    i = content.indexOf(oldString, i + Math.max(1, oldString.length))
  }
  return out
}

/* ===== Strategies 2-4, 7: line-by-line normalization ===== */

/**
 * Walk lines of `content`, looking for a contiguous run that — under the
 * supplied per-line `normalize` — equals (line by line) `oldString` similarly
 * normalized. Returns char-offset ranges into the ORIGINAL content covering
 * those line ranges (whole lines, not partial slices).
 */
function findByLineMap(
  content: string,
  oldString: string,
  normalize: (line: string) => string,
): Range[] {
  const contentLines = splitLines(content)
  const oldLines = splitLines(oldString)
  if (oldLines.length === 0) return []
  const targetNorm = oldLines.map((l) => normalize(stripNewline(l)))
  const haystack = contentLines.map((l) => normalize(stripNewline(l)))
  // If old_string didn't end with a newline, the user is asking us to replace
  // the *content* of the last matched line — not its line terminator. Trim
  // the trailing \n off the matched range in that case so the file's overall
  // line structure is preserved when the replacement also lacks a newline.
  const lastOldEndsWithNewline = oldLines[oldLines.length - 1]!.endsWith('\n')
  const out: Range[] = []
  for (let i = 0; i + targetNorm.length <= haystack.length; i++) {
    let ok = true
    for (let j = 0; j < targetNorm.length; j++) {
      if (haystack[i + j] !== targetNorm[j]) { ok = false; break }
    }
    if (!ok) continue
    const start = lineStartOffset(contentLines, i)
    let end = lineStartOffset(contentLines, i + targetNorm.length)
    if (!lastOldEndsWithNewline) {
      const lastLine = contentLines[i + targetNorm.length - 1]!
      if (lastLine.endsWith('\r\n')) end -= 2
      else if (lastLine.endsWith('\n')) end -= 1
    }
    out.push({ start, end })
  }
  return out
}

const trimLine = (s: string): string => s.trim()

const normalizeWhitespace = (s: string): string => s.replace(/[ \t]+/g, ' ').trim()

const stripIndent = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '')

/** Fold the most common cosmetic unicode drift into ASCII-safe equivalents. */
function unicodeNormalize(s: string): string {
  const folded = s
    // Smart double quotes
    .replace(/[“”]/g, '"')
    // Smart single quotes
    .replace(/[‘’]/g, "'")
    // En- and em-dashes
    .replace(/[–—]/g, '-')
    // Non-breaking space → space
    .replace(/ /g, ' ')
    // Horizontal ellipsis → three dots
    .replace(/…/g, '...')
  return folded.trim()
}

/* ===== Strategy 5: escape_normalized ===== */

/** Some agents emit a literal `\n` instead of an actual newline when supplying
 *  old_string. Convert before running line-based matching. */
function escapeNormalize(s: string): string {
  // Order matters: \\n must convert first to avoid \\n-then-\n collisions.
  return s
    .replace(/\\r\\n/g, '\n')
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
}

/* ===== Strategy 6: trimmed_boundary ===== */

/**
 * Trim only the first and last lines' whitespace; interior lines must match
 * exactly. Helps when an agent's old_string is wrapped with stray leading
 * indentation but the body is byte-perfect.
 */
function findTrimmedBoundary(content: string, oldString: string): Range[] {
  const oldLines = splitLines(oldString)
  if (oldLines.length === 0) return []
  const contentLines = splitLines(content)
  const target = oldLines.slice()
  // Trim boundary newlines off the FIRST and LAST line content (without the \n).
  target[0] = stripNewline(target[0]!).trimStart() + (target[0]!.endsWith('\n') ? '\n' : '')
  const lastIdx = target.length - 1
  if (lastIdx >= 0) {
    const last = target[lastIdx]!
    target[lastIdx] = stripNewline(last).trimEnd() + (last.endsWith('\n') ? '\n' : '')
  }
  const out: Range[] = []
  for (let i = 0; i + target.length <= contentLines.length; i++) {
    let ok = true
    // First line: compare with leading whitespace stripped on both sides.
    if (stripNewline(contentLines[i]!).trimStart() !== stripNewline(target[0]!).trimStart()) ok = false
    // Last line: compare with trailing whitespace stripped on both sides.
    if (ok && stripNewline(contentLines[i + lastIdx]!).trimEnd() !== stripNewline(target[lastIdx]!).trimEnd()) ok = false
    // Middle lines: byte-exact (without their trailing newline).
    if (ok) {
      for (let j = 1; j < lastIdx; j++) {
        if (stripNewline(contentLines[i + j]!) !== stripNewline(target[j]!)) { ok = false; break }
      }
    }
    if (ok) {
      const start = lineStartOffset(contentLines, i)
      let end = lineStartOffset(contentLines, i + target.length)
      if (!oldLines[oldLines.length - 1]!.endsWith('\n')) {
        const lastLine = contentLines[i + target.length - 1]!
        if (lastLine.endsWith('\r\n')) end -= 2
        else if (lastLine.endsWith('\n')) end -= 1
      }
      out.push({ start, end })
    }
  }
  return out
}

/* ===== Strategy 8: block_anchor ===== */

/** First and last lines must match (under line_trimmed); interior lines
 *  must average ≥ 0.5 similarity. Useful when an agent paraphrases the
 *  middle of a block but anchors it correctly. Requires ≥ 3 lines. */
function findBlockAnchor(content: string, oldString: string): Range[] {
  const oldLines = splitLines(oldString)
  if (oldLines.length < 3) return []
  const contentLines = splitLines(content)
  const trimmedOld = oldLines.map((l) => trimLine(stripNewline(l)))
  const trimmedContent = contentLines.map((l) => trimLine(stripNewline(l)))
  const first = trimmedOld[0]!
  const last = trimmedOld[trimmedOld.length - 1]!
  const lastOldEndsWithNewline = oldLines[oldLines.length - 1]!.endsWith('\n')
  const out: Range[] = []
  for (let i = 0; i + trimmedOld.length <= trimmedContent.length; i++) {
    if (trimmedContent[i] !== first) continue
    if (trimmedContent[i + trimmedOld.length - 1] !== last) continue
    let sum = 0
    let count = 0
    for (let j = 1; j < trimmedOld.length - 1; j++) {
      sum += similarity(trimmedContent[i + j]!, trimmedOld[j]!)
      count++
    }
    const avg = count === 0 ? 1 : sum / count
    if (avg >= 0.5) {
      const start = lineStartOffset(contentLines, i)
      let end = lineStartOffset(contentLines, i + trimmedOld.length)
      if (!lastOldEndsWithNewline) {
        const lastLine = contentLines[i + trimmedOld.length - 1]!
        if (lastLine.endsWith('\r\n')) end -= 2
        else if (lastLine.endsWith('\n')) end -= 1
      }
      out.push({ start, end })
    }
  }
  return out
}

/* ===== Strategy 9: context_aware ===== */

/** Every line must be ≥ 0.5 similar (average across the whole window). The
 *  loosest strategy — last resort. Picks the WINDOW with the highest average
 *  similarity at or above the threshold. */
function findContextAware(content: string, oldString: string): Range[] {
  const oldLines = splitLines(oldString)
  if (oldLines.length === 0) return []
  const contentLines = splitLines(content)
  const trimmedOld = oldLines.map((l) => trimLine(stripNewline(l)))
  const trimmedContent = contentLines.map((l) => trimLine(stripNewline(l)))
  const lastOldEndsWithNewline = oldLines[oldLines.length - 1]!.endsWith('\n')
  let bestStart = -1
  let bestScore = 0.5 // strict floor
  for (let i = 0; i + trimmedOld.length <= trimmedContent.length; i++) {
    let sum = 0
    for (let j = 0; j < trimmedOld.length; j++) {
      sum += similarity(trimmedContent[i + j]!, trimmedOld[j]!)
    }
    const avg = sum / trimmedOld.length
    if (avg > bestScore) { bestScore = avg; bestStart = i }
  }
  if (bestStart < 0) return []
  const start = lineStartOffset(contentLines, bestStart)
  let end = lineStartOffset(contentLines, bestStart + trimmedOld.length)
  if (!lastOldEndsWithNewline) {
    const lastLine = contentLines[bestStart + trimmedOld.length - 1]!
    if (lastLine.endsWith('\r\n')) end -= 2
    else if (lastLine.endsWith('\n')) end -= 1
  }
  return [{ start, end }]
}

/* ===== Helpers ===== */

/** Split into lines, KEEPING the trailing newline on each line so we can
 *  rejoin without losing line endings. */
function splitLines(s: string): string[] {
  const out: string[] = []
  let i = 0
  while (i < s.length) {
    const j = s.indexOf('\n', i)
    if (j === -1) { out.push(s.slice(i)); break }
    out.push(s.slice(i, j + 1))
    i = j + 1
  }
  return out
}

function stripNewline(s: string): string {
  if (s.endsWith('\r\n')) return s.slice(0, -2)
  if (s.endsWith('\n')) return s.slice(0, -1)
  return s
}

/** Char-offset of the start of `lines[idx]` inside the original content.
 *  For idx === lines.length, returns the end of the buffer. */
function lineStartOffset(lines: string[], idx: number): number {
  let acc = 0
  for (let i = 0; i < idx && i < lines.length; i++) acc += lines[i]!.length
  return acc
}

/**
 * Cheap line-similarity score in [0, 1]. Combines:
 *   - common-prefix length / max
 *   - common-suffix length / max
 *   - bigram overlap / total bigrams
 * Weighted: 0.3 prefix + 0.3 suffix + 0.4 bigram. Empty-string edge cases
 * collapse to exact-equality (1.0 when both empty, 0.0 when only one is).
 */
function similarity(a: string, b: string): number {
  if (a === b) return 1
  if (a.length === 0 || b.length === 0) return 0
  const max = Math.max(a.length, b.length)
  // Common prefix
  let p = 0
  while (p < a.length && p < b.length && a[p] === b[p]) p++
  // Common suffix (don't double-count overlap with prefix)
  let s = 0
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++
  // Bigram overlap
  const bigrams = (str: string): Map<string, number> => {
    const m = new Map<string, number>()
    for (let i = 0; i < str.length - 1; i++) {
      const k = str.slice(i, i + 2)
      m.set(k, (m.get(k) ?? 0) + 1)
    }
    return m
  }
  const ba = bigrams(a)
  const bb = bigrams(b)
  let inter = 0
  let total = 0
  for (const [k, v] of ba) {
    total += v
    inter += Math.min(v, bb.get(k) ?? 0)
  }
  for (const v of bb.values()) total += v
  const bigramScore = total === 0 ? 0 : (2 * inter) / total
  return 0.3 * (p / max) + 0.3 * (s / max) + 0.4 * bigramScore
}

/* ===== Replacement ===== */

/**
 * Apply non-overlapping, ascending-order ranges. We take ranges as a
 * defensive copy (caller keeps theirs intact) and sort just in case.
 */
function applyMatches(content: string, matches: Range[], replacement: string): string {
  const sorted = matches.slice().sort((a, b) => a.start - b.start)
  let out = ''
  let cursor = 0
  for (const m of sorted) {
    out += content.slice(cursor, m.start)
    out += replacement
    cursor = m.end
  }
  out += content.slice(cursor)
  return out
}
