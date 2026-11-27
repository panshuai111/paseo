import type { PluginServerContext } from "@getpaseo/plugin/server";
import { cancel, predict, preferences } from "./shared/prediction";

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(preferences);
  const requests = new Map<string, AbortController>();
  const blocked = new Set<string>();
  const unsubscribe = settings.subscribe(() => {
    for (const controller of requests.values()) controller.abort();
  });
  const stopOutcome = server.on("agent.turn_ended", ({ agent, outcome }) => {
    if (outcome.kind === "completed") blocked.delete(agent.id);
    else blocked.add(agent.id);
  });
  const stopArchive = server.on("agent.archived", ({ agent }) => {
    blocked.delete(agent.id);
  });
  server.handle(cancel, ({ token }) => {
    requests.get(token)?.abort();
    return {};
  });
  server.handle(predict, async ({ agentId, revision, token }, { paseo }) => {
    const controller = new AbortController();
    requests.set(token, controller);
    try {
      const state = await settings.read();
      if (state.status !== "ready") throw new Error(state.error);
      if (!state.values.enabled || blocked.has(agentId) || controller.signal.aborted)
        return { text: null };
      const agent = paseo.agents.ref(agentId);
      if (typeof agent.suggestReply !== "function")
        throw new Error("Update this host to the local reply-suggestions build.");
      const text = await agent.suggestReply({
        revision,
        prompt: state.values.prompt,
        signal: controller.signal,
      });
      return { text };
    } finally {
      requests.delete(token);
    }
  });
  return () => {
    unsubscribe();
    stopOutcome();
    stopArchive();
    for (const controller of requests.values()) controller.abort();
    requests.clear();
  };
}
