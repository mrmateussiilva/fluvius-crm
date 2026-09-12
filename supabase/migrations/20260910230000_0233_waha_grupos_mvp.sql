-- 0233 — grupos WAHA na Inbox, com contato sintético e sem lead/IA.
-- Não altera nulabilidade nem índices de identidade de pessoas/chats 1:1.
-- Sem fusão automática de dados legados: se um clone já criou duplicatas desta
-- identidade reservada, o índice recusa a migration para revisão do histórico.
create unique index if not exists contacts_waha_group_unique
  on public.contacts (organization_id, (source_metadata->>'waha_group_chat_id'))
  where source_metadata->>'waha_group_chat_id' is not null
    and is_merged_into is null;

create unique index if not exists conversations_waha_group_session_unique
  on public.conversations (organization_id, channel_session_id, group_chat_id)
  where is_group = true and group_chat_id is not null;

create or replace function public.fn_upsert_wa_group_conversation(
  p_org uuid,
  p_session uuid,
  p_group_chat_id text
)
returns table (contact_id uuid, conversation_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_contact uuid;
  v_conversation uuid;
begin
  if p_group_chat_id is null or right(p_group_chat_id, 5) <> '@g.us'
     or length(btrim(left(p_group_chat_id, -5))) = 0 then
    raise exception using errcode = '22023', message = 'invalid_group_chat_id';
  end if;

  -- Service-only: o webhook resolve a organização pela sessão, nunca pelo body.
  -- A RPC também impede associar um grupo a uma sessão de outro tenant/provider.
  perform 1 from public.channel_sessions s
    where s.id = p_session and s.organization_id = p_org and s.provider = 'waha'
    for share;
  if not found then
    raise exception using errcode = '22023', message = 'invalid_group_session';
  end if;

  insert into public.contacts as c (
    organization_id, source, phone_number, display_name, source_metadata
  ) values (
    p_org, 'whatsapp', null,
    'Grupo WhatsApp • ' || left(p_group_chat_id, 8),
    jsonb_build_object('waha_group', true, 'waha_group_chat_id', p_group_chat_id)
  )
  on conflict (organization_id, (source_metadata->>'waha_group_chat_id'))
    where source_metadata->>'waha_group_chat_id' is not null and is_merged_into is null
  do update set source_metadata = c.source_metadata
  returning c.id into v_contact;

  insert into public.conversations as c (
    organization_id, contact_id, channel_session_id, channel, status, is_group, group_chat_id
  ) values (
    p_org, v_contact, p_session, 'whatsapp', 'open', true, p_group_chat_id
  )
  on conflict (organization_id, channel_session_id, group_chat_id)
    where is_group = true and group_chat_id is not null
  do update set contact_id = excluded.contact_id
  returning c.id into v_conversation;

  return query select v_contact, v_conversation;
end;
$$;

revoke execute on function public.fn_upsert_wa_group_conversation(uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.fn_upsert_wa_group_conversation(uuid, uuid, text)
  to service_role;
