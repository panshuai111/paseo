import React, { act, useCallback, useRef, useState, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ComposerKeyboardScopeProvider } from "../keyboard-scope";
import {
  ComposerSuggestionBinding,
  type ComposerSuggestion,
  type SuggestionBindingHandle,
} from "./binding";
import { suggestionRegistry } from "./registry";

class TextSource {
  private text = "";
  private readonly listeners = new Set<() => void>();
  getSnapshot = () => this.text;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  set = (text: string) => {
    this.text = text;
    for (const listener of this.listeners) listener();
  };
}

const source = new TextSource();
const mounted: Root[] = [];
const removals: Array<() => void> = [];

beforeEach(() => {
  vi.stubGlobal("React", React);
  source.set("");
});
afterEach(() => {
  for (const root of mounted.splice(0)) act(() => root.unmount());
  for (const remove of removals.splice(0)) remove();
  document.body.replaceChildren();
});

function Harness({ active = true }: { active?: boolean }) {
  const ref = useRef<SuggestionBindingHandle>(null);
  const [suggestion, setSuggestion] = useState<ComposerSuggestion | null>(null);
  const text = useSyncExternalStore(source.subscribe, source.getSnapshot);
  const change = useCallback(
    (event: React.ChangeEvent<HTMLTextAreaElement>) => source.set(event.target.value),
    [],
  );
  const key = useCallback((event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return;
    ref.current?.onKeyPress({
      key: event.key,
      hasModifier: event.shiftKey,
      preventDefault: () => event.preventDefault(),
      input: { text: source.getSnapshot(), selection: { start: 0, end: 0 } },
    });
  }, []);
  return (
    <ComposerKeyboardScopeProvider isActiveComposer={active} isPaneFocused={active}>
      <ComposerSuggestionBinding
        ref={ref}
        serverId="host"
        agentId="agent"
        revision="revision"
        enabled={true}
        hasAttachments={false}
        text={source}
        onChange={setSuggestion}
        onAccept={source.set}
      />
      <textarea
        data-testid="input"
        placeholder={suggestion?.text ?? "Write"}
        value={text}
        onChange={change}
        onKeyDown={key}
      />
    </ComposerKeyboardScopeProvider>
  );
}

function mount(active = true) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted.push(root);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() =>
    root.render(
      <QueryClientProvider client={queryClient}>
        <Harness active={active} />
      </QueryClientProvider>,
    ),
  );
  const input = container.querySelector("textarea");
  if (!input) throw new Error("Missing input");
  return { container, input };
}

function keypress(input: HTMLTextAreaElement, key: string, composing = false) {
  act(() => {
    input.dispatchEvent(
      new KeyboardEvent("keydown", {
        key,
        isComposing: composing,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
}

describe("composer suggestions", () => {
  it("keeps a suggestion outside the draft until Tab, and respects IME composition", async () => {
    removals.push(
      suggestionRegistry.add("host", { id: "test", provide: async () => "请给一个例子" }),
    );
    const { input } = mount();
    await expect.poll(() => input.placeholder).toBe("请给一个例子");
    expect(input.value).toBe("");
    keypress(input, "Tab", true);
    expect(input.value).toBe("");
    keypress(input, "Tab");
    expect(input.value).toBe("请给一个例子");
    expect(document.querySelector('[data-testid="reply-suggestion-controls"]')).toBeNull();
  });

  it("cancels on user input and discards a late answer", async () => {
    let finish: (text: string) => void = () => {};
    let signal: AbortSignal | null = null;
    removals.push(
      suggestionRegistry.add("host", {
        id: "test",
        provide: (request) => {
          signal = request.signal;
          return new Promise<string>((resolve) => {
            finish = resolve;
          });
        },
      }),
    );
    const { input } = mount();
    await expect.poll(() => signal !== null).toBe(true);
    act(() => source.set("自己的内容"));
    await expect.poll(() => signal?.aborted).toBe(true);
    await act(async () => {
      finish("旧建议");
      await Promise.resolve();
    });
    expect(input.value).toBe("自己的内容");
    expect(input.placeholder).toBe("Write");
    act(() => source.set(""));
    expect(input.placeholder).toBe("Write");
  });

  it("does not request suggestions for a hidden composer", () => {
    const provide = vi.fn(async () => "example");
    removals.push(suggestionRegistry.add("host", { id: "test", provide }));
    mount(false);
    expect(provide).toHaveBeenCalledTimes(0);
  });

  it("accepts with ArrowRight without rendering a controls row", async () => {
    removals.push(
      suggestionRegistry.add("host", { id: "test", provide: async () => "Show an example" }),
    );
    const { container, input } = mount();
    await expect.poll(() => input.placeholder).toBe("Show an example");
    expect(container.querySelectorAll("button")).toHaveLength(0);
    keypress(input, "ArrowRight", true);
    expect(input.value).toBe("");
    keypress(input, "ArrowRight");
    expect(input.value).toBe("Show an example");
  });
});
