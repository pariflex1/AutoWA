import { NextResponse } from 'next/server'
import { createClient, createChatbotClient } from '@/lib/supabase/server'
import { normalizePhone } from '@/lib/whatsapp/phone-utils'
import { findExistingContact } from '@/lib/contacts/dedupe'

export async function POST(request: Request) {
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

    const chatbotSupabase = await createChatbotClient()

    // Fetch the 100 most recent messages from the chatbot's conversations table
    const { data: chatbotMsgs, error: fetchError } = await chatbotSupabase
      .from('conversations')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(100)

    if (fetchError || !chatbotMsgs) {
      console.error('Failed to fetch chatbot messages:', fetchError)
      return NextResponse.json({ error: 'Failed to fetch chatbot messages' }, { status: 500 })
    }

    // Process in chronological order (oldest first)
    const reversedMsgs = [...chatbotMsgs].reverse()
    
    let syncedCount = 0

    for (const msg of reversedMsgs) {
      // Dedup check: use message_id column only (we always set message_id = msg.id on insert).
      // Checking `id.eq.${msg.id}` caused false-positive skips when the chatbot UUID
      // happened to match an unrelated local row or on re-runs after a partial failure.
      const { data: existingMsg } = await supabase
        .from('messages')
        .select('id')
        .eq('message_id', msg.id)
        .maybeSingle()

      if (existingMsg) continue

      // 1. Resolve contact by phone.
      //
      // IMPORTANT: Bot (assistant) messages must NEVER create a new contact.
      // If no existing contact is found for a bot reply, it means the customer
      // hasn't messaged us yet through the main webhook path — skip the bot
      // message rather than creating a phantom "Bot Customer" contact.
      const existingContact = await findExistingContact(
        supabase,
        accountId,
        msg.phone
      )

      let contactId = ''
      if (existingContact) {
        contactId = existingContact.id
      } else if (msg.role !== 'user') {
        // Bot reply with no matching customer contact — skip silently.
        // The customer's own message will create the contact when it syncs.
        continue
      } else {
        // Customer message with no contact yet — create one.
        const { data: newContact, error: createContactErr } = await supabase
          .from('contacts')
          .insert({
            phone: normalizePhone(msg.phone),
            name: 'Customer',
            account_id: accountId,
            user_id: user.id
          })
          .select('id')
          .single()

        if (createContactErr || !newContact) {
          console.error('Failed to create contact for sync:', createContactErr)
          continue
        }
        contactId = newContact.id
      }

      // 2. Find or create conversation locally.
      //
      // Again: bot messages must not create new conversations. If no conversation
      // exists yet for this contact, the customer message hasn't been processed
      // yet — skip the bot reply; it will sync correctly once the customer message
      // is processed first (reversed chronological order handles this).
      let conversationId = ''
      const { data: existingConv } = await supabase
        .from('conversations')
        .select('id, unread_count')
        .eq('contact_id', contactId)
        .eq('account_id', accountId)
        .maybeSingle()

      if (existingConv) {
        conversationId = existingConv.id
      } else if (msg.role !== 'user') {
        // Bot reply but no conversation exists yet — skip.
        continue
      } else {
        // Customer message — create conversation.
        const { data: newConv, error: createConvErr } = await supabase
          .from('conversations')
          .insert({
            contact_id: contactId,
            account_id: accountId,
            user_id: user.id
          })
          .select('id')
          .single()

        if (createConvErr || !newConv) {
          console.error('Failed to create conversation for sync:', createConvErr)
          continue
        }
        conversationId = newConv.id
      }

      // 3. Insert the message locally
      const senderType = msg.role === 'user' ? 'customer' : 'agent'
      const contentType = msg.message_type || 'text'

      const { error: insertMsgErr } = await supabase
        .from('messages')
        .insert({
          id: msg.id,
          conversation_id: conversationId,
          sender_type: senderType,
          content_type: contentType,
          content_text: msg.message,
          message_id: msg.id,
          status: 'delivered',
          created_at: msg.created_at
        })

      if (insertMsgErr) {
        console.error('Failed to insert synced message:', insertMsgErr)
        continue
      }

      // 4. Update the conversation
      const isUnread = senderType === 'customer'
      const unreadIncrement = isUnread ? 1 : 0

      await supabase
        .from('conversations')
        .update({
          last_message_text: msg.message || `[${contentType}]`,
          last_message_at: msg.created_at,
          unread_count: (existingConv?.unread_count || 0) + unreadIncrement,
          updated_at: new Date().toISOString()
        })
        .eq('id', conversationId)

      syncedCount++
    }

    return NextResponse.json({ success: true, syncedCount })
  } catch (error) {
    console.error('Error in chatbot sync POST:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
