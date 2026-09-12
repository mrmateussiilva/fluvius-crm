import { expect, it, vi } from "vitest";
vi.mock("@/lib/agent-engine/agent/agent-config", () => ({ loadConversationAgentConfig: vi.fn() }));
vi.mock("@/lib/agent-engine/agent/inbound-turn", () => ({ latestCheckpoint: vi.fn(), runAgentPreview: vi.fn() }));
import { generateReplyDraft } from "@/lib/agent-engine/agent/reply-drafts";
import { loadConversationAgentConfig } from "@/lib/agent-engine/agent/agent-config";
import { runAgentPreview } from "@/lib/agent-engine/agent/inbound-turn";

it("sugestão de resposta recusa grupo antes de resolver agente ou chamar modelo", async () => {
  const query = vi.fn(async () => ({ rows: [{ is_group: true, group_chat_id: "123@g.us" }] }));
  await expect(generateReplyDraft({ query } as never, {} as never, {
    organizationId: "org", conversationId: "group", contactId: "synthetic", channelId: "session",
  })).rejects.toThrow("reply_group_not_supported");
  expect(query).toHaveBeenCalledWith(expect.stringContaining("organization_id=$1"), ["org", "group"]);
  expect(loadConversationAgentConfig).not.toHaveBeenCalled();
  expect(runAgentPreview).not.toHaveBeenCalled();
});
