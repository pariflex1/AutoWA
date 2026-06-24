import { createServerClient } from '@supabase/ssr'
import { createClient as createBaseClient } from '@supabase/supabase-js'
import { cookies } from 'next/headers'

export async function createClient() {
  const cookieStore = await cookies()

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll()
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            )
          } catch {
            // The `setAll` method was called from a Server Component.
            // This can be ignored if you have middleware refreshing sessions.
          }
        },
      },
    }
  )
}

export async function createChatbotClient() {
  const url = process.env.NEXT_PUBLIC_CHATBOT_SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL!
  
  // Prefer chatbot service role key, then chatbot anon key, then default service role key, then default anon key
  const key = process.env.CHATBOT_SUPABASE_SERVICE_ROLE_KEY || 
              process.env.NEXT_PUBLIC_CHATBOT_SUPABASE_ANON_KEY || 
              process.env.SUPABASE_SERVICE_ROLE_KEY || 
              process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!

  return createBaseClient(url, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    }
  })
}

