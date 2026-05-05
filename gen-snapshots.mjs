// Regenerate .expected.jsonl snapshot files for the captured real-pi traces.
// Run after a deliberate change to src/events/pi-event-mapper.ts:
//
//   node --import tsx gen-snapshots.mjs
//
// Then `git diff tests/fixtures/pi-event-mapper/real-pi/*.expected.jsonl`,
// review every line, commit. The snapshot tests in tests/pi-event-mapper.test.mjs
// will then assert the new outputs line-for-line.

import fs from 'node:fs'
import path from 'node:path'
import url from 'node:url'

import { mapPiEvent, INITIAL_STATE } from './src/events/index.ts'

const __dirname = path.dirname(url.fileURLToPath(import.meta.url))
const FIX = path.join(__dirname, 'tests', 'fixtures', 'pi-event-mapper', 'real-pi')

function readJsonl(file) {
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l))
}

function makeCtx() {
  let t = 0
  let m = 0
  return {
    runId: 'r1',
    sessionKey: 's1',
    prompt: 'hello',
    nextTurnId: () => `t-${++t}`,
    nextMessageId: () => `m-${++m}`,
  }
}

const TRACES = ['pi-json-hello', 'pi-json-tool']

for (const name of TRACES) {
  const inputs = readJsonl(path.join(FIX, `${name}.jsonl`))
  let state = INITIAL_STATE
  const ctx = makeCtx()
  const lines = []
  for (const e of inputs) {
    const r = mapPiEvent(e, state, ctx)
    lines.push(JSON.stringify(r.events))
    state = r.state
  }
  const out = path.join(FIX, `${name}.expected.jsonl`)
  fs.writeFileSync(out, lines.join('\n') + '\n')
  console.log(`wrote ${path.relative(__dirname, out)}: ${lines.length} lines`)
}
