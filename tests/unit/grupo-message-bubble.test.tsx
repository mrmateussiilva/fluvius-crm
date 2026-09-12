import { render, screen, cleanup } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { MessageBubble } from "@/components/inbox/MessageBubble";
import type { Message } from "@/lib/types/messaging";

vi.mock("@/components/inbox/media/MediaRenderer", () => ({ MediaRenderer: () => null }));
vi.mock("@/components/inbox/media/ContactCard", () => ({ ContactCard: () => null }));
vi.mock("@/components/ai/CitationButton", () => ({ CitationButton: () => null }));
afterEach(cleanup);
const message = (metadata: Record<string, unknown>): Message => ({
  id: "msg", organization_id: "org", conversation_id: "conv", channel_session_id: "session", contact_id: "synthetic",
  external_id: "external", type: "text", direction: "inbound", status: "delivered", ack: 2,
  error_code: null, error_message: null, body: "Mensagem de teste", media_url: null, media_mime: null,
  media_size_bytes: null, media_storage_path: null, sent_via: "user", sent_by_user_id: null,
  sent_at: "2026-09-10T12:00:00.000Z", delivered_at: null, read_at: null, metadata,
  edited_at: null, revoked_at: null, reply_to_message_id: null, created_at: "2026-09-10T12:00:00.000Z",
});
it("mostra o autor inbound e mantém o corpo do histórico", () => {
  render(<MessageBubble message={message({ is_group: true, group_sender_name: "Autora teste", group_sender_id: "123@lid" })} />);
  expect(screen.getByText("Autora teste")).toBeTruthy();
  expect(screen.getByText("Mensagem de teste")).toBeTruthy();
});
it("ID é fallback quando o nome não veio", () => {
  render(<MessageBubble message={message({ is_group: true, group_sender_id: "123@lid" })} />);
  expect(screen.getByText("123@lid")).toBeTruthy();
});
it("conversa privada não ganha rótulo de grupo", () => {
  render(<MessageBubble message={message({ group_sender_name: "Autora teste" })} />);
  expect(screen.queryByText("Autora teste")).toBeNull();
});
