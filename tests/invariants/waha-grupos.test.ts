/** RPC real: rodar com pnpm test:db somente após autorização para aplicar o SQL no banco de teste. */
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { beforeAll, describe, expect, it } from "vitest";
import { GOV_ORG, GOV_SESSION, GOV_VIEWER, countAs, seedGov, sql } from "./gov-helpers";

const execFileAsync = promisify(execFile);
const org2 = randomUUID();
const session2 = randomUUID();
const sessionOtherOrg = randomUUID();
const callSql = (chat: string, org = GOV_ORG, session = GOV_SESSION) =>
  `select row_to_json(r) from public.fn_upsert_wa_group_conversation('${org}', '${session}', '${chat}') r;`;
const upsert = (chat: string, org = GOV_ORG, session = GOV_SESSION): { contact_id: string; conversation_id: string } => JSON.parse(sql(callSql(chat, org, session)));

beforeAll(() => {
  seedGov();
  sql(`insert into public.organizations(id,slug,legal_name,display_name) values ('${org2}','waha-group-invariant','Grupo teste','Grupo teste');
    insert into public.channel_sessions(id,organization_id,waha_session_name,webhook_secret_encrypted,provider) values
      ('${session2}','${GOV_ORG}','group-session-two','\\x00'::bytea,'waha'),
      ('${sessionOtherOrg}','${org2}','group-other-org','\\x00'::bytea,'waha');`);
});

describe("grupo WAHA: identidade atômica, isolamento e contato obrigatório", () => {
  it("primeira mensagem cria contato sintético/conversa; segunda reutiliza ambos", () => {
    const chat = "120363111111111@g.us";
    const first = upsert(chat);
    const contact = JSON.parse(sql(`select row_to_json(c) from public.contacts c where id='${first.contact_id}';`));
    expect(contact).toMatchObject({ organization_id: GOV_ORG, source: "whatsapp", phone_number: null, display_name: "Grupo WhatsApp • 12036311", source_metadata: { waha_group: true, waha_group_chat_id: chat } });
    const conversation = JSON.parse(sql(`select row_to_json(c) from public.conversations c where id='${first.conversation_id}';`));
    expect(conversation).toMatchObject({ organization_id: GOV_ORG, contact_id: first.contact_id, channel_session_id: GOV_SESSION, channel: "whatsapp", status: "open", is_group: true, group_chat_id: chat });
    for (const id of ["first", "second"]) {
      const resolved = upsert(chat);
      expect(resolved).toEqual(first);
      sql(`insert into public.messages(organization_id,conversation_id,contact_id,channel_session_id,external_id,direction,status,type,body,sent_via)
        values('${GOV_ORG}','${resolved.conversation_id}','${resolved.contact_id}','${GOV_SESSION}','group-${id}','inbound','delivered','text','Teste sintético','external_device');`);
    }
    expect(sql(`select count(*) from public.messages where conversation_id='${first.conversation_id}';`)).toBe("2");
    expect(sql(`select count(*) from public.crm_leads where organization_id='${GOV_ORG}' and contact_id='${first.contact_id}';`)).toBe("0");
    expect(sql(`select count(*) from public.event_log where organization_id='${GOV_ORG}' and event_type='ai_agent.dispatch_requested' and payload->>'conversation_id'='${first.conversation_id}';`)).toBe("0");
  });
  it("corrida de webhooks em conexões independentes não duplica", async () => {
    const calls = await Promise.all(Array.from({ length: 8 }, async () => {
      const { stdout } = await execFileAsync("docker", ["exec", process.env.TEST_DB_CONTAINER!, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-tA", "-c", callSql("120363222222222@g.us")]);
      return JSON.parse(stdout.trim());
    }));
    expect(new Set(calls.map((c) => c.contact_id)).size).toBe(1);
    expect(new Set(calls.map((c) => c.conversation_id)).size).toBe(1);
    expect(sql(`select count(*) from public.contacts where organization_id='${GOV_ORG}' and source_metadata->>'waha_group_chat_id'='120363222222222@g.us' and is_merged_into is null;`)).toBe("1");
  });
  it("grupos distintos não dividem contato/conversa", () => {
    const a = upsert("120363333333333@g.us"), b = upsert("120363444444444@g.us");
    expect(a.contact_id).not.toBe(b.contact_id); expect(a.conversation_id).not.toBe(b.conversation_id);
  });
  it("mesmo grupo em sessões distintas compartilha contato e separa conversa", () => {
    const a = upsert("120363555555555@g.us"), b = upsert("120363555555555@g.us", GOV_ORG, session2);
    expect(a.contact_id).toBe(b.contact_id); expect(a.conversation_id).not.toBe(b.conversation_id);
    expect(upsert("120363555555555@g.us", GOV_ORG, session2)).toEqual(b);
  });
  it("organizações distintas não colidem e RLS esconde o outro tenant", () => {
    const a = upsert("120363666666666@g.us"), b = upsert("120363666666666@g.us", org2, sessionOtherOrg);
    expect(a.contact_id).not.toBe(b.contact_id); expect(a.conversation_id).not.toBe(b.conversation_id);
    expect(countAs(GOV_VIEWER, `select count(*) from public.contacts where id='${b.contact_id}';`)).toBe(0);
    expect(countAs(GOV_VIEWER, `select count(*) from public.conversations where id='${b.conversation_id}';`)).toBe(0);
  });
  it("recusa sessão de outro tenant e chat que não é grupo", () => {
    expect(() => upsert("120363777777777@g.us", GOV_ORG, sessionOtherOrg)).toThrow();
    for (const invalid of ["", "@g.us", "5511999999999@c.us", "123@lid"]) expect(() => upsert(invalid)).toThrow();
  });
  it("não expõe a RPC a anon/authenticated e mantém contact_id NOT NULL", () => {
    for (const role of ["anon", "authenticated"]) {
      expect(sql(`select has_function_privilege('${role}', 'public.fn_upsert_wa_group_conversation(uuid,uuid,text)', 'execute');`)).toBe("f");
    }
    expect(sql("select has_function_privilege('service_role', 'public.fn_upsert_wa_group_conversation(uuid,uuid,text)', 'execute');")).toBe("t");
    expect(sql("select count(*) from information_schema.columns where table_schema='public' and table_name in ('messages','conversations') and column_name='contact_id' and is_nullable='NO';")).toBe("2");
  });
});
