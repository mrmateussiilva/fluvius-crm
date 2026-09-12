import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
vi.mock("@/lib/channels/health", () => ({ sincronizarSaudeDaConexao: vi.fn() }));
vi.mock("@/lib/channels/pos-entrada", () => ({ aplicarEfeitosPosEntrada: vi.fn() }));
vi.mock("@/lib/escalacao/atendimento-manual", () => ({ pausarIaPorAtendimentoManual: vi.fn() }));
vi.mock("@/lib/dev/kick-local-pipeline", () => ({ acelerarPipelineDeEventos: vi.fn() }));
const wahaClientMock = vi.hoisted(() => ({ getGroupInfo: vi.fn() }));
vi.mock("@/lib/waha/client", () => ({ getWahaClient: () => wahaClientMock }));

import { dispatchWahaEvent, parseChatId, type Admin, type WahaPayload } from "@/lib/waha/ingest";
import { aplicarEfeitosPosEntrada } from "@/lib/channels/pos-entrada";
import { pausarIaPorAtendimentoManual } from "@/lib/escalacao/atendimento-manual";
import { acelerarPipelineDeEventos } from "@/lib/dev/kick-local-pipeline";
import { audit } from "@/lib/audit";
import { wahaEnvelopeSchema } from "@/lib/waha/envelope";
import { groupMessageSender } from "@/lib/types/messaging";

const session = { id: "session", organization_id: "org", waha_session_name: "waha-session", is_warmup_complete: true, warmup_started_at: null };
const chat = "120363000000001@g.us";
const payload = (patch: WahaPayload = {}): WahaPayload => ({ id: "false_group_A", from: chat, body: "Olá grupo", timestamp: 1700000000, ...patch });

/** O mock mede o contrato do ingest; atomicidade da RPC é provada em invariants. */
function database(options: { duplicate?: boolean; echo?: boolean; rpcError?: boolean; contact?: Record<string, unknown> | null } = {}) {
  const inserted: Record<string, unknown>[] = [];
  const updated: Record<string, unknown>[] = [];
  const filters: unknown[][] = [];
  const contact = options.contact === undefined
    ? { id: "group-contact", display_name: "Grupo WhatsApp • 12036300", source_metadata: { waha_group: true, waha_group_chat_id: chat, preservado: true } }
    : options.contact;
  const rpc = vi.fn(async (name: string) => {
    if (name === "fn_upsert_wa_group_conversation") return {
      data: options.rpcError ? null : [{ contact_id: "group-contact", conversation_id: "group-conversation" }],
      error: options.rpcError ? { code: "22023" } : null,
    };
    return { data: name === "fn_upsert_wa_contact" ? "person" : "private-conversation", error: null };
  });
  const from = vi.fn((table: string) => {
    let insert = false;
    let update = false;
    const chain = {
      error: null,
      select: () => chain,
      insert: (row: Record<string, unknown>) => { inserted.push(row); insert = true; return chain; },
      update: (row: Record<string, unknown>) => { updated.push(row); update = true; return chain; },
      eq: (...args: unknown[]) => { filters.push(args); return chain; },
      in: (...args: unknown[]) => { filters.push(args); return chain; },
      limit: () => chain,
      maybeSingle: async () => {
        if (insert) return { data: options.duplicate ? null : { id: "message" }, error: options.duplicate ? { code: "23505" } : null };
        if (update) return { data: null, error: null };
        if (table === "contacts") return { data: contact, error: null };
        return { data: options.echo ? { id: "existing" } : null, error: null };
      },
    };
    return chain;
  });
  return { admin: { from, rpc } as unknown as Admin, rpc, inserted, updated, filters };
}
const receive = (db: ReturnType<typeof database>, p = payload()) => dispatchWahaEvent(db.admin, session, { event: "message.any", payload: p }, "request");
beforeEach(() => {
  vi.clearAllMocks();
  wahaClientMock.getGroupInfo.mockResolvedValue({ ok: false });
});

describe("grupos WAHA: persistência isolada dos efeitos de pessoa", () => {
  it("parse mantém @g.us como group", () => expect(parseChatId(chat)).toEqual({ kind: "group", phone: null, lid: null }));
  it("usa a RPC própria e mantém identidade, autor, timestamps, ack e mídia", async () => {
    const db = database();
    await receive(db, payload({ author: "author@lid", ack: 2, ackName: "DEVICE", type: "image", media: { url: "https://media.test/a.jpg", mimetype: "image/jpeg" }, _data: { pushName: "Pessoa teste" } }));
    expect(db.rpc).toHaveBeenCalledWith("fn_upsert_wa_group_conversation", { p_org: "org", p_session: "session", p_group_chat_id: chat });
    expect(db.inserted[0]).toMatchObject({ contact_id: "group-contact", conversation_id: "group-conversation", direction: "inbound", external_id: "false_group_A", ack: 2, sent_at: "2023-11-14T22:13:20.000Z", media_url: "https://media.test/a.jpg", metadata: { is_group: true, group_chat_id: chat, group_sender_id: "author@lid", group_sender_name: "Pessoa teste", raw_type: "image", ack_name: "DEVICE" } });
    expect(db.rpc).toHaveBeenCalledWith("fn_mark_conversation_message", expect.objectContaining({ p_conv: "group-conversation", p_direction: "inbound" }));
    expect(db.rpc).toHaveBeenCalledWith("emit_event", expect.objectContaining({ p_event_type: "media.persist_requested" }));
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "message.received" }));
    expect(db.rpc.mock.calls.some(([name]) => name === "fn_upsert_wa_contact")).toBe(false);
    expect(aplicarEfeitosPosEntrada).not.toHaveBeenCalled();
    expect(acelerarPipelineDeEventos).not.toHaveBeenCalled();
  });
  it("enriquece contato sintético com subject e metadata do grupo", async () => {
    wahaClientMock.getGroupInfo.mockResolvedValue({
      ok: true,
      info: {
        id: chat,
        subject: "Tess",
        size: 2,
        owner: "owner@lid",
        creation: 1789170981,
        isCommunity: false,
        announce: false,
        restrict: false,
      },
    });
    const db = database();
    await receive(db);
    expect(wahaClientMock.getGroupInfo).toHaveBeenCalledWith("waha-session", chat);
    expect(db.updated[0]).toMatchObject({
      display_name: "Tess",
      source_metadata: expect.objectContaining({
        preservado: true,
        waha_group: true,
        waha_group_chat_id: chat,
        waha_group_subject: "Tess",
        waha_group_size: 2,
        waha_group_owner: "owner@lid",
        waha_group_creation: 1789170981,
        waha_group_is_community: false,
        waha_group_announce: false,
        waha_group_restrict: false,
        waha_group_metadata_last_attempt_at: expect.any(String),
        waha_group_metadata_synced_at: expect.any(String),
      }),
    });
  });
  it("não consulta metadata de grupo já sincronizada", async () => {
    const db = database({
      contact: { id: "group-contact", display_name: "Tess", source_metadata: { waha_group_subject: "Tess", waha_group_metadata_synced_at: "2026-09-10T12:00:00.000Z" } },
    });
    await receive(db, payload({ id: "false_group_B" }));
    expect(wahaClientMock.getGroupInfo).not.toHaveBeenCalled();
    expect(db.updated).toHaveLength(0);
  });
  it("falha de metadata não impede persistência e não grava synced_at", async () => {
    wahaClientMock.getGroupInfo.mockResolvedValue({ ok: false });
    const db = database();
    await receive(db);
    expect(db.inserted).toHaveLength(1);
    expect(db.rpc).toHaveBeenCalledWith("fn_mark_conversation_message", expect.objectContaining({ p_conv: "group-conversation" }));
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "message.received" }));
    expect(db.updated[0]?.source_metadata).toMatchObject({
      waha_group: true,
      waha_group_chat_id: chat,
      waha_group_metadata_last_attempt_at: expect.any(String),
    });
    expect(db.updated[0]?.source_metadata).not.toHaveProperty("waha_group_metadata_synced_at");
  });
  it("tentativa recente sem sucesso não consulta WAHA de novo", async () => {
    const db = database({
      contact: {
        id: "group-contact",
        display_name: "Grupo WhatsApp • 12036300",
        source_metadata: {
          waha_group: true,
          waha_group_chat_id: chat,
          waha_group_metadata_last_attempt_at: new Date(Date.now() - 2 * 60 * 1000).toISOString(),
        },
      },
    });
    await receive(db, payload({ id: "false_group_RECENT" }));
    expect(wahaClientMock.getGroupInfo).not.toHaveBeenCalled();
    expect(db.updated).toHaveLength(0);
  });
  it("tentativa antiga sem sucesso permite retry", async () => {
    const db = database({
      contact: {
        id: "group-contact",
        display_name: "Grupo WhatsApp • 12036300",
        source_metadata: {
          waha_group: true,
          waha_group_chat_id: chat,
          waha_group_metadata_last_attempt_at: new Date(Date.now() - 11 * 60 * 1000).toISOString(),
        },
      },
    });
    await receive(db, payload({ id: "false_group_OLD" }));
    expect(wahaClientMock.getGroupInfo).toHaveBeenCalledWith("waha-session", chat);
  });
  it("subject vazio mantém fallback e marca metadata como sincronizada", async () => {
    wahaClientMock.getGroupInfo.mockResolvedValue({
      ok: true,
      info: {
        id: chat,
        subject: "  ",
        size: null,
        owner: null,
        creation: null,
        isCommunity: false,
        announce: false,
        restrict: false,
      },
    });
    const db = database();
    await receive(db);
    expect(db.updated[0]).not.toHaveProperty("display_name");
    expect(db.updated[0]?.source_metadata).toMatchObject({
      waha_group: true,
      waha_group_chat_id: chat,
      waha_group_subject: null,
      waha_group_size: null,
      waha_group_metadata_last_attempt_at: expect.any(String),
      waha_group_metadata_synced_at: expect.any(String),
    });
  });
  it("subject null válido sincroniza e não cria retry posterior", async () => {
    wahaClientMock.getGroupInfo.mockResolvedValue({
      ok: true,
      info: {
        id: chat,
        subject: null,
        size: 2,
        owner: null,
        creation: null,
        isCommunity: false,
        announce: false,
        restrict: false,
      },
    });
    const db = database();
    await receive(db);
    expect(db.updated[0]).not.toHaveProperty("display_name");
    expect(db.updated[0]?.source_metadata).toMatchObject({
      waha_group_subject: null,
      waha_group_size: 2,
      waha_group_metadata_synced_at: expect.any(String),
    });

    vi.clearAllMocks();
    const skipped = database({
      contact: { id: "group-contact", display_name: "Grupo WhatsApp • 12036300", source_metadata: db.updated[0]?.source_metadata as Record<string, unknown> },
    });
    await receive(skipped, payload({ id: "false_group_AFTER_NULL" }));
    expect(wahaClientMock.getGroupInfo).not.toHaveBeenCalled();
    expect(skipped.updated).toHaveLength(0);
  });
  it.each([
    [{ author: "a", participant: "b" }, "a"],
    [{ author: " ", participant: "b" }, "b"],
    [{ author: 3, participant: false, _data: { key: { participant: "c", participantAlt: "d" } } }, "c"],
    [{ _data: { key: { participant: "", participantAlt: "d" } } }, "d"],
    [{}, null],
  ])("autor aceita apenas strings não vazias e respeita precedência: %j", async (patch, expected) => {
    const db = database();
    await receive(db, payload(patch as WahaPayload));
    expect(db.inserted[0]?.metadata).toMatchObject({ group_sender_id: expected });
  });
  it("schema continua loose e preserva autor/participante", () => {
    const parsed = wahaEnvelopeSchema.parse({ payload: payload({ author: "a", participant: "b", _data: { key: { participant: "c", participantAlt: "d", future: 1 } } }), future: true });
    expect(parsed.payload?._data?.key).toMatchObject({ participant: "c", participantAlt: "d", future: 1 });
    expect(parsed.future).toBe(true);
  });
  it.each([{ id: null }, { id: " " }, { body: "" }, { body: "  " }])("descarta evento sem mensagem: %j", async (patch) => {
    const db = database(); await receive(db, payload(patch));
    expect(db.rpc).not.toHaveBeenCalled(); expect(db.inserted).toHaveLength(0);
  });
  it("dedup não carimba, audita nem reacelera efeitos", async () => {
    const db = database({ duplicate: true }); await receive(db);
    expect(db.rpc).toHaveBeenCalledTimes(1); expect(audit).not.toHaveBeenCalled();
    expect(aplicarEfeitosPosEntrada).not.toHaveBeenCalled(); expect(acelerarPipelineDeEventos).not.toHaveBeenCalled();
  });
  it("falha da RPC não insere mensagem nem cai na RPC de pessoa", async () => {
    const db = database({ rpcError: true }); await receive(db);
    expect(db.inserted).toHaveLength(0); expect(db.rpc).toHaveBeenCalledTimes(1);
  });
  it("1:1 mantém resolução de pessoa, conversa e efeitos pós-entrada", async () => {
    const db = database(); await receive(db, payload({ from: "5511999999999@c.us" }));
    expect(db.rpc.mock.calls.map(([name]) => name)).toContain("fn_upsert_wa_contact");
    expect(db.rpc.mock.calls.map(([name]) => name)).toContain("fn_upsert_wa_conversation");
    expect(aplicarEfeitosPosEntrada).toHaveBeenCalledTimes(1);
    expect(db.inserted[0]?.metadata).not.toHaveProperty("is_group");
  });
  it.each(["to", "id", "from"])("celular resolve grupo via %s sem lead/IA", async (origin) => {
    const db = database();
    await receive(db, payload({ fromMe: true, id: origin === "id" ? `true_${chat}_BARE` : "BARE", to: origin === "to" ? chat : undefined, from: origin === "from" ? chat : "5511999999999@c.us" }));
    expect(db.inserted[0]).toMatchObject({ contact_id: "group-contact", direction: "outbound", sent_via: "external_device", metadata: { is_group: true, fromMe: true } });
    expect(pausarIaPorAtendimentoManual).not.toHaveBeenCalled();
    expect(aplicarEfeitosPosEntrada).not.toHaveBeenCalled();
  });
  it("eco do composer compara ID composto e bare antes da RPC", async () => {
    const db = database({ echo: true }); await receive(db, payload({ fromMe: true, id: `true_${chat}_BARE` }));
    expect(db.filters).toContainEqual(["external_id", [`true_${chat}_BARE`, "BARE"]]);
    expect(db.filters).toContainEqual(["organization_id", "org"]);
    expect(db.rpc).not.toHaveBeenCalled(); expect(db.inserted).toHaveLength(0);
  });
  it("autor na Inbox usa nome e fallback ID sem alterar 1:1", () => {
    expect(groupMessageSender({ is_group: true, group_sender_name: " Pessoa ", group_sender_id: "id" })).toBe("Pessoa");
    expect(groupMessageSender({ is_group: true, group_sender_name: "", group_sender_id: "id" })).toBe("id");
    expect(groupMessageSender({ group_sender_name: "Pessoa" })).toBeNull();
  });
});
