import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import ts from 'typescript'

// Exercise the actual UI handlers without a live Supabase account.
const source = ts.createSourceFile('App.tsx', await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
const functions = new Map()
function visit(node) {
  if (ts.isFunctionDeclaration(node) && node.name) functions.set(node.name.text, node.getText(source))
  ts.forEachChild(node, visit)
}
visit(source)

function harness(handlerName, overrides = {}) {
  const calls = []
  const context = {
    modal: null,
    gear: [{ id: 'gear', name: 'Playing cue', memberId: null }],
    members: [{ id: 'duplicate', name: 'Duplicate' }, { id: 'kept', name: 'Kept member' }],
    schoolYears: [{ id: 'first', label: '2025/26' }, { id: 'year', label: '2026/27' }],
    mergeTargetId: 'kept',
    isDeletingGear: false, isDeletingMember: false, isSavingYear: false, isMerging: false,
    supabase: { rpc: async (...args) => { calls.push(args); return { data: [], error: null } } },
    recordHandoff: async (...args) => { calls.push(args); return { date: '2026-10-07' } },
    fetchActivity: async () => [],
    window: { confirm: () => false },
    errorMessage: (error, fallback) => error?.message ?? fallback,
    ...overrides,
  }
  for (const name of ['setGear', 'setMembers', 'setActivity', 'setSchoolYears', 'setNewYearLabel', 'setDataError', 'setYearError', 'setDeleteGearError', 'setDeleteMemberError', 'setMergeError', 'setIsDeletingGear', 'setIsDeletingMember', 'setIsSavingYear', 'setIsMerging', 'setModal']) {
    context[name] = (value) => { context[name[3].toLowerCase() + name.slice(4)] = value }
  }
  const script = ts.transpileModule(`${functions.get(handlerName)}\nglobalThis.handler = ${handlerName}`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
  vm.runInNewContext(script, context)
  return { context, calls, submit: () => context.handler({ preventDefault() {} }) }
}

test('delete handlers do nothing without their confirmation dialog or after cancellation', async () => {
  for (const handler of ['handleDeleteGear', 'handleDeleteMember', 'handleDeleteSchoolYear']) {
    const state = harness(handler)
    await state.submit()
    assert.equal(state.calls.length, 0)
  }
})

test('confirmed deletions invoke the correct mutation once and close the dialog', async () => {
  for (const [handler, modal, mutation] of [
    ['handleDeleteGear', { kind: 'delete-gear', gearId: 'gear' }, 'Removed'],
    ['handleDeleteMember', { kind: 'delete-member', memberId: 'duplicate' }, 'delete_member'],
    ['handleDeleteSchoolYear', { kind: 'delete-year', yearId: 'year' }, 'delete_school_year'],
  ]) {
    const state = harness(handler, { modal })
    await state.submit()
    assert.equal(state.calls.length, 1)
    assert.equal(handler === 'handleDeleteGear' ? state.calls[0][1] : state.calls[0][0], mutation)
    assert.equal(state.context.modal, null)
  }
})

test('pending deletions cannot be submitted again', async () => {
  for (const [handler, modal, busy] of [
    ['handleDeleteGear', { kind: 'delete-gear', gearId: 'gear' }, 'isDeletingGear'],
    ['handleDeleteMember', { kind: 'delete-member', memberId: 'duplicate' }, 'isDeletingMember'],
    ['handleDeleteSchoolYear', { kind: 'delete-year', yearId: 'year' }, 'isSavingYear'],
  ]) {
    const state = harness(handler, { modal, [busy]: true })
    await state.submit()
    assert.equal(state.calls.length, 0)
  }
})

test('failed equipment removal keeps the confirmation open for retry', async () => {
  const modal = { kind: 'delete-gear', gearId: 'gear' }
  const state = harness('handleDeleteGear', { modal, recordHandoff: async () => null })
  await state.submit()
  assert.equal(state.context.modal, modal)
  assert.ok(state.context.deleteGearError)
  assert.equal(state.context.isDeletingGear, false)
})

test('member merge cannot remove a duplicate unless its final prompt is accepted', async () => {
  const state = harness('handleMerge', { modal: { kind: 'merge-member', memberId: 'duplicate' } })
  await state.submit()
  assert.equal(state.calls.length, 0)
  state.context.window.confirm = () => true
  await state.submit()
  assert.equal(state.calls.length, 1)
  assert.equal(state.calls[0][0], 'merge_members')
})
