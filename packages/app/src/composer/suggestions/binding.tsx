import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useState,
  useSyncExternalStore,
  type Ref,
} from "react";
import { useFetchQuery } from "@/data/query";
import { useComposerKeyboardScope } from "@/composer/keyboard-scope";
import type { ComposerTextSource } from "@/composer/text-source";
import type { ComposerKeyPressEvent } from "@/composer/input/input";
import { suggestionRegistry, type RegisteredSuggestionProvider } from "./registry";

export interface SuggestionBindingHandle {
  onKeyPress(event: ComposerKeyPressEvent): boolean;
}

export interface ComposerSuggestion {
  revision: string;
  text: string;
}

interface BindingProps {
  ref: Ref<SuggestionBindingHandle>;
  serverId: string;
  agentId: string;
  revision: string | null;
  enabled: boolean;
  hasAttachments: boolean;
  text: ComposerTextSource;
  onChange(suggestion: ComposerSuggestion | null): void;
  onAccept(text: string): void;
}

interface GenerationProps extends Omit<
  BindingProps,
  "serverId" | "enabled" | "hasAttachments" | "text"
> {
  revision: string;
  registration: RegisteredSuggestionProvider;
  dismiss(): void;
  getText(): string;
}

function isCompletedSuggestion(): boolean {
  return true;
}

function SuggestionGeneration({
  ref,
  agentId,
  revision,
  registration,
  onChange,
  onAccept,
  dismiss,
  getText,
}: GenerationProps) {
  const query = useFetchQuery({
    queryKey: ["composer-suggestion", registration.key, agentId, revision],
    queryFn: async ({ signal }) => {
      const value = await registration.provider.provide({ agentId, revision, signal });
      if (value === null) return null;
      if (typeof value !== "string" || value.length > 500)
        throw new Error("Invalid reply suggestion");
      return value.trim() || null;
    },
    retry: false,
    dataShape: "value",
    immutableWhen: isCompletedSuggestion,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    gcTime: 5 * 60_000,
  });
  const text = query.data ?? null;
  useEffect(() => {
    onChange(text ? { revision, text } : null);
    return () => onChange(null);
  }, [text, revision, onChange]);
  const accept = useCallback(() => {
    if (!text || getText().length !== 0) return;
    onAccept(text);
    dismiss();
  }, [text, getText, onAccept, dismiss]);
  useImperativeHandle(ref, () => ({
    onKeyPress(event) {
      if (event.hasModifier || event.input.text.length !== 0 || getText().length !== 0)
        return false;
      if (event.key === "Escape") {
        event.preventDefault();
        dismiss();
        return true;
      }
      if ((event.key !== "Tab" && event.key !== "ArrowRight") || !text) return false;
      event.preventDefault();
      accept();
      return true;
    },
  }));
  return null;
}

export function ComposerSuggestionBinding(props: BindingProps) {
  const registrations = useSyncExternalStore(
    suggestionRegistry.subscribe,
    suggestionRegistry.getSnapshot,
  );
  const currentText = useSyncExternalStore(props.text.subscribe, props.text.getSnapshot);
  const { isActiveComposer } = useComposerKeyboardScope();
  const [dismissed, setDismissed] = useState<string | null>(null);
  const registration = registrations.find((entry) => entry.serverId === props.serverId);
  const hasDraft = currentText.length > 0 || props.hasAttachments;
  useEffect(() => {
    if (hasDraft) setDismissed(props.revision);
  }, [hasDraft, props.revision]);
  const eligible =
    props.enabled &&
    isActiveComposer &&
    !hasDraft &&
    props.revision &&
    dismissed !== props.revision;
  const dismiss = useCallback(() => setDismissed(props.revision), [props.revision]);
  if (!registration || !eligible || !props.revision) return null;
  return (
    <SuggestionGeneration
      {...props}
      revision={props.revision}
      registration={registration}
      dismiss={dismiss}
      getText={props.text.getSnapshot}
    />
  );
}
