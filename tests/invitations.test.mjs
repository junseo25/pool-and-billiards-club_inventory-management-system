import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createInviteHandler } from '../supabase/functions/invite-member/handler.ts'

const memberId = '00000000-0000-0000-0000-000000000001'
const member = { id: memberId, name: 'Alex Smith', email: 'alex@virginia.edu', phone: '(434) 555-0123', auth_user_id: null, invitation_sent_at: null }
const appUrl = 'https://junseo25.github.io/pool-and-billiards-club_inventory-management-system/'

function setup(overrides = {}) {
  const sent = []
  const marked = []
  const handler = createInviteHandler({
    getUser: async (token) => token === 'valid-token' ? 'executive-id' : null,
    isExecutive: async () => true,
    getMember: async () => member,
    sendInvite: async (recipient, redirect) => { sent.push({ recipient, redirect }); return null },
    markSent: async (id) => { marked.push(id) },
    ...overrides,
  }, appUrl)
  const request = (token = 'valid-token', body = { memberId }) => new Request('https://functions.test/invite-member', {
    method: 'POST', headers: token ? { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } : {},
    body: JSON.stringify(body),
  })
  return { handler, request, sent, marked }
}

test('only approved executives can send invitations; recipients and redirects come from server records', async () => {
  const { handler, request, sent, marked } = setup()
  assert.equal((await handler(request(''))).status, 401)
  assert.equal((await handler(request('invalid'))).status, 401)
  assert.equal(sent.length, 0)
  const unapproved = setup({ isExecutive: async () => false })
  assert.equal((await unapproved.handler(unapproved.request())).status, 403)
  assert.equal(unapproved.sent.length, 0)
  const response = await handler(request('valid-token', { memberId, email: 'attacker@example.com', redirectTo: 'https://attacker.example/' }))
  assert.equal(response.status, 200)
  assert.equal(sent[0].recipient.email, member.email)
  assert.equal(sent[0].redirect, `${appUrl}?setup=password`)
  assert.deepEqual(marked, [memberId])
  const preflight = await handler(new Request('https://functions.test', { method: 'OPTIONS' }))
  assert.equal(preflight.status, 204)
  assert.match(preflight.headers.get('Access-Control-Allow-Headers'), /authorization/)
})

test('missing contact, linked accounts and rate limits do not trigger additional emails', async () => {
  for (const [record, status] of [[null,404], [{ ...member, email: '' },400], [{ ...member, auth_user_id: 'account' },409], [{ ...member, invitation_sent_at: new Date().toISOString() },429]]) {
    const { handler, request, sent } = setup({ getMember: async () => record })
    assert.equal((await handler(request())).status, status)
    assert.equal(sent.length, 0)
  }
  const limited = setup({ sendInvite: async () => ({ status: 429, message: 'Email rate limit exceeded' }) })
  const response = await limited.handler(limited.request())
  assert.equal(response.status, 429)
  assert.equal((await response.json()).error, 'Email rate limit exceeded')
  assert.equal(limited.marked.length, 0)
  const bookkeepingFailure = setup({ markSent: async () => { throw new Error('Database unavailable') } })
  assert.equal((await bookkeepingFailure.handler(bookkeepingFailure.request())).status, 200)
  assert.equal(bookkeepingFailure.sent.length, 1)
})
