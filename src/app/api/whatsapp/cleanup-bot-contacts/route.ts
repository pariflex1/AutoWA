import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'

/**
 * POST /api/whatsapp/cleanup-bot-contacts
 *
 * One-time cleanup: deletes contacts named exactly "Bot Customer" that were
 * created by the old sync route bug. Cascades to their conversations and
 * messages via the FK ON DELETE CASCADE on those tables.
 *
 * Only accessible to authenticated users. Safe to call multiple times.
 */
export async function POST() {
  try {
    const supabase = await createClient()

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    // Resolve caller's account_id
    const { data: profile } = await supabase
      .from('profiles')
      .select('account_id')
      .eq('user_id', user.id)
      .maybeSingle()
    const accountId = profile?.account_id as string | undefined
    if (!accountId) {
      return NextResponse.json({ error: 'Profile not linked to an account.' }, { status: 403 })
    }

    // Use service-role client to bypass RLS for the cascade delete
    const admin = createAdminClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    )

    // Step 1: Find all "Bot Customer" contacts for this account.
    // These were created by the old sync bug when msg.role !== 'user'.
    const { data: botContacts, error: findErr } = await admin
      .from('contacts')
      .select('id, phone, name')
      .eq('account_id', accountId)
      .eq('name', 'Bot Customer')

    if (findErr) {
      console.error('[cleanup] Failed to find bot contacts:', findErr)
      return NextResponse.json({ error: 'Failed to find bot contacts' }, { status: 500 })
    }

    if (!botContacts || botContacts.length === 0) {
      return NextResponse.json({ success: true, deleted: 0, message: 'No Bot Customer contacts found' })
    }

    const botContactIds = botContacts.map((c: { id: string }) => c.id)

    // Step 2: Find conversations for those contacts.
    const { data: botConvs, error: convFindErr } = await admin
      .from('conversations')
      .select('id')
      .eq('account_id', accountId)
      .in('contact_id', botContactIds)

    if (convFindErr) {
      console.error('[cleanup] Failed to find bot conversations:', convFindErr)
      return NextResponse.json({ error: 'Failed to find bot conversations' }, { status: 500 })
    }

    const botConvIds = (botConvs ?? []).map((c: { id: string }) => c.id)

    // Step 3: Delete messages in those conversations.
    if (botConvIds.length > 0) {
      const { error: msgDelErr } = await admin
        .from('messages')
        .delete()
        .in('conversation_id', botConvIds)

      if (msgDelErr) {
        console.error('[cleanup] Failed to delete bot messages:', msgDelErr)
        return NextResponse.json({ error: 'Failed to delete bot messages' }, { status: 500 })
      }
    }

    // Step 4: Delete the conversations.
    if (botConvIds.length > 0) {
      const { error: convDelErr } = await admin
        .from('conversations')
        .delete()
        .in('id', botConvIds)

      if (convDelErr) {
        console.error('[cleanup] Failed to delete bot conversations:', convDelErr)
        return NextResponse.json({ error: 'Failed to delete bot conversations' }, { status: 500 })
      }
    }

    // Step 5: Delete the "Bot Customer" contacts themselves.
    const { error: contactDelErr } = await admin
      .from('contacts')
      .delete()
      .in('id', botContactIds)

    if (contactDelErr) {
      console.error('[cleanup] Failed to delete bot contacts:', contactDelErr)
      return NextResponse.json({ error: 'Failed to delete bot contacts' }, { status: 500 })
    }

    console.log(`[cleanup] Deleted ${botContactIds.length} Bot Customer contacts and ${botConvIds.length} conversations.`)

    return NextResponse.json({
      success: true,
      deleted: botContactIds.length,
      conversationsRemoved: botConvIds.length,
      contacts: botContacts.map((c: { id: string; phone: string; name: string }) => ({ id: c.id, phone: c.phone })),
    })
  } catch (error) {
    console.error('[cleanup] Unexpected error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
