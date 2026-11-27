import type { PluginCleanup } from "../contracts.js";

export interface PluginComposerSuggestionRequest {
  agentId: string;
  revision: string;
  signal: AbortSignal;
}

export interface PluginComposerSuggestionProvider {
  id: string;
  provide(request: PluginComposerSuggestionRequest): Promise<string | null>;
}

export type RegisterComposerSuggestionProvider = (
  provider: PluginComposerSuggestionProvider,
) => PluginCleanup;
