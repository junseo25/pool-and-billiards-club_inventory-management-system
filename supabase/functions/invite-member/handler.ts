type Member = { id: string; email: string; name: string; phone: string; auth_user_id: string | null; invitation_sent_at: string | null }
type ErrorResult = { message: string; status?: number }
export type InviteServices = {
  getUser: (token: string) => Promise<string | null>
  isExecutive: (userId: string) => Promise<boolean>
  getMember: (memberId: string) => Promise<Member | null>
  sendInvite: (member: Member, redirectTo: string) => Promise<ErrorResult | null>
  markSent: (memberId: string) => Promise<void>
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, traceparent, tracestate, baggage',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

export function createInviteHandler(services: InviteServices, appUrl: string) {
  const response = (status: number, body: object) => new Response(JSON.stringify(body), {
    status, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
  return async (request: Request): Promise<Response> => {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders })
    if (request.method !== 'POST') return response(405, { error: 'Use POST.' })
    try {
      const token = request.headers.get('Authorization')?.match(/^Bearer\s+(.+)$/i)?.[1]
      if (!token) return response(401, { error: 'Sign in to send an invitation.' })
      const userId = await services.getUser(token)
      if (!userId) return response(401, { error: 'Your session expired. Sign in again.' })
      if (!await services.isExecutive(userId)) return response(403, { error: 'Executive access required.' })
      let body: { memberId?: unknown }
      try { body = await request.json() } catch { return response(400, { error: 'Invalid request.' }) }
      if (!body || typeof body.memberId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body.memberId)) {
        return response(400, { error: 'Choose a valid member.' })
      }
      // Derive recipient and redirect from trusted records/configuration,
      // never from a browser-supplied email or redirect URL.
      const member = await services.getMember(body.memberId)
      if (!member) return response(404, { error: 'Member not found.' })
      if (!member.email.trim()) return response(400, { error: 'Add an email to this member first.' })
      if (member.auth_user_id) return response(409, { error: 'This member already has a login account. Use password recovery if needed.' })
      if (member.invitation_sent_at && Date.now() - Date.parse(member.invitation_sent_at) < 60_000) {
        return response(429, { error: 'An invitation was just sent. Wait before retrying.' })
      }
      const redirect = new URL(appUrl)
      redirect.searchParams.set('setup', 'password')
      const error = await services.sendInvite(member, redirect.toString())
      if (error) return response(error.status === 429 ? 429 : 400, { error: error.message })
      // An invitation has already gone out if this bookkeeping fails.
      try { await services.markSent(member.id) } catch { /* Do not encourage duplicate sends. */ }
      return response(200, { message: `Invitation sent to ${member.email}.` })
    } catch {
      return response(500, { error: 'Could not send the invitation. Check the function configuration and try again.' })
    }
  }
}
