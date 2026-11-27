import type { PluginClientContext } from "@getpaseo/plugin/client";
import { Settings } from "./client/settings";
import { cancel, predict } from "./shared/prediction";

export default function contribute(client: PluginClientContext) {
  client.addSettingsScreen({
    id: "predictions",
    title: "回复建议 / Reply suggestions",
    icon: "Sparkles",
    Component: Settings,
  });
  const register = client.addComposerSuggestionProvider;
  if (!register) return () => {};
  return register({
    id: "reply-suggestions",
    async provide({ agentId, revision, signal }) {
      const token = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
      const pending = client.rpc(predict, { agentId, revision, token });
      const abort = () => {
        void client.rpc(cancel, { token }).catch(() => undefined);
      };
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      try {
        const result = await pending;
        return signal.aborted ? null : result.text;
      } finally {
        signal.removeEventListener("abort", abort);
      }
    },
  });
}
