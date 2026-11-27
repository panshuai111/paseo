import type { PluginButtonRegistration, PluginClientContext } from "@getpaseo/plugin/client";

const legacyNotice = "来自 Hermes 飞书会话，继续对话请在飞书发送。";

export default function register(client: PluginClientContext) {
  const removeTransformer = client.addTimelineTransformer({
    id: "hide-legacy-read-only-notice",
    query: { itemType: "notification" },
    transform({ item }) {
      if (item.level === "info" && item.message === legacyNotice) return { items: [] };
    },
  });

  const lifetime = new AbortController();
  const pills = new Map<string, { workspaceId: string; registration: PluginButtonRegistration }>();

  function removePill(agentId: string) {
    pills.get(agentId)?.registration.remove();
    pills.delete(agentId);
  }

  function updatePill(agent: { id: string; provider: string; workspaceId?: string | null }) {
    if (lifetime.signal.aborted) return;
    if (agent.provider !== "hermes-feishu" || !agent.workspaceId) {
      removePill(agent.id);
      return;
    }
    if (pills.get(agent.id)?.workspaceId === agent.workspaceId) return;
    removePill(agent.id);
    const registration = client.addComposerPill({
      id: "hermes-guidance",
      workspaceId: agent.workspaceId,
      agentId: agent.id,
      button: {
        title: "输入文字可引导 Hermes 当前任务。引导不会作为飞书消息发送。",
        label: "引导当前任务",
        icon: "Info",
        disabled: true,
        behavior: { kind: "action", onPress() {} },
      },
    });
    pills.set(agent.id, { workspaceId: agent.workspaceId, registration });
  }

  void client.paseo.agents
    .list({ subscribe: {}, signal: lifetime.signal })
    .then(({ subscription }) => {
      if (lifetime.signal.aborted) return undefined;
      subscription.subscribe({
        snapshot: ({ entries }) => {
          const ids = new Set(entries.map(({ agent }) => agent.id));
          for (const id of pills.keys()) if (!ids.has(id)) removePill(id);
          for (const { agent } of entries) updatePill(agent);
        },
        update: (message) => {
          if (message.type !== "agent_update") return;
          const update = message.payload;
          if (update.kind === "remove") removePill(update.agentId);
          else updatePill(update.agent);
        },
      });
      return undefined;
    })
    .catch((error: unknown) => {
      if (!lifetime.signal.aborted) console.warn("Hermes guidance indicator:", error);
    });

  return () => {
    lifetime.abort();
    for (const id of pills.keys()) removePill(id);
    removeTransformer();
  };
}
