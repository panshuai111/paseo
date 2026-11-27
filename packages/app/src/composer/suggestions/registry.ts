import type { PluginComposerSuggestionProvider } from "@getpaseo/plugin/client";

export interface RegisteredSuggestionProvider {
  key: number;
  serverId: string;
  provider: PluginComposerSuggestionProvider;
}

export class SuggestionRegistry {
  private entries: readonly RegisteredSuggestionProvider[] = [];
  private readonly listeners = new Set<() => void>();
  private nextKey = 0;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  getSnapshot = () => this.entries;

  add(serverId: string, provider: PluginComposerSuggestionProvider): () => void {
    if (!provider.id.trim() || typeof provider.provide !== "function")
      throw new Error("Invalid suggestion provider");
    const entry = { key: this.nextKey++, serverId, provider };
    this.entries = [...this.entries, entry];
    this.notify();
    return () => {
      if (!this.entries.includes(entry)) return;
      this.entries = this.entries.filter((candidate) => candidate !== entry);
      this.notify();
    };
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}

export const suggestionRegistry = new SuggestionRegistry();
