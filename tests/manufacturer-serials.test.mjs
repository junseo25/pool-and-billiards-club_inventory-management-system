import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import ts from 'typescript'

const source = ts.createSourceFile('App.tsx', await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
const functions = new Map()
function visit(node) {
  if (ts.isFunctionDeclaration(node) && node.name) functions.set(node.name.text, node.getText(source))
  ts.forEachChild(node, visit)
}
visit(source)

function harness(handler, serialNumber) {
  let saved
  const query = {
    insert: (payload) => { saved = payload; return query },
    update: (payload) => { saved = payload; return query },
    eq: () => query,
    select: () => query,
    single: async () => ({ data: { id: 'gear', ...saved }, error: null }),
    maybeSingle: async () => ({ data: null, error: null }),
  }
  const context = {
    serialNumber,
    modal: { kind: 'edit-gear', gearId: 'gear' },
    isSavingGear: false,
    newGearCategory: 'Shaft', newGearCueUse: 'Jump',
    supabase: { from: () => query },
    FormData: class { constructor(fields) { this.fields = fields } get(key) { return this.fields[key] } },
    errorMessage: (error, fallback) => error?.message ?? fallback,
  }
  for (const name of ['setGear', 'setActivity', 'setModal', 'setDataError', 'setIsSavingGear', 'setGearEditError', 'setNewGearCategory', 'setNewGearCueUse', 'setSerialNumber']) {
    context[name] = (value) => { context[name[3].toLowerCase() + name.slice(4)] = value }
  }
  vm.runInNewContext(ts.transpileModule(`${functions.get(handler)}\nglobalThis.handler = ${handler}`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context)
  return { context, saved: () => saved, submit: () => context.handler({ preventDefault() {}, currentTarget: { name: 'Manufacturer cue', category: 'Butt', cueUse: 'Break' } }) }
}

test('adding and editing equipment preserve manufacturer serials without automatic formatting', async () => {
  for (const handler of ['handleAddGear', 'handleEditGear']) {
    for (const serial of ['0000123456789012', 'MEZZ-001/X', 'SH-0042-P', '', '  00042  ']) {
      const state = harness(handler, serial)
      await state.submit()
      assert.equal(state.saved().serial, serial.trim())
      assert.equal(state.context.modal, null)
    }
  }
})

test('opening equipment editing retains the full stored serial, including legacy IDs', () => {
  for (const serial of ['BU-000012-P', 'MANUFACTURER-01/X', '00042']) {
    const state = harness('editGear', '')
    state.context.handler({ id: 'gear', category: 'Butt', cueUse: 'Playing', serial })
    assert.equal(state.context.serialNumber, serial)
    assert.equal(state.context.modal.kind, 'edit-gear')
  }
})
