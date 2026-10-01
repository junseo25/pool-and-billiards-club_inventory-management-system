import { createClient } from 'npm:@supabase/supabase-js@2.117.2'
import { createInviteHandler } from './handler.ts'

const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { persistSession: false, autoRefreshToken: false },
})
const appUrl = Deno.env.get('APP_URL') ?? 'https://junseo25.github.io/pool-and-billiards-club_inventory-management-system/'

Deno.serve(createInviteHandler({
  async getUser(token) {
    const { data, error } = await admin.auth.getUser(token)
    return error ? null : data.user?.id ?? null
  },
  async isExecutive(userId) {
    const { data, error } = await admin.from('executive_access').select('user_id').eq('user_id', userId).maybeSingle()
    if (error) throw error
    return Boolean(data)
  },
  async getMember(memberId) {
    const { data, error } = await admin.from('members')
      .select('id,email,name,phone,auth_user_id,invitation_sent_at').eq('id', memberId).maybeSingle()
    if (error) throw error
    return data
  },
  async sendInvite(member, redirectTo) {
    const { error } = await admin.auth.admin.inviteUserByEmail(member.email.trim(), {
      redirectTo, data: { full_name: member.name, phone: member.phone },
    })
    return error
  },
  async markSent(memberId) {
    const { error } = await admin.from('members').update({ invitation_sent_at: new Date().toISOString() }).eq('id', memberId)
    if (error) throw error
  },
}, appUrl))
