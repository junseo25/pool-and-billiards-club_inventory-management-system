import { createClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

// Capture the callback before the auth client consumes and clears its fragment.
const callbackParams = new URLSearchParams(window.location.hash.slice(1))
export const isPasswordSetupLink = ['invite', 'recovery'].includes(callbackParams.get('type') ?? '')
  || new URLSearchParams(window.location.search).get('setup') === 'password'
export const authCallbackError = callbackParams.get('error_description') ?? ''

export const isSupabaseConfigured = Boolean(supabaseUrl && supabaseAnonKey)

export const supabase = isSupabaseConfigured
  ? createClient(supabaseUrl, supabaseAnonKey, {
      auth: {
        autoRefreshToken: true,
        detectSessionInUrl: true,
        persistSession: true,
      },
    })
  : null
