import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { Markdown } from "@getpaseo/plugin/client/ui";
import { View } from "react-native";
import { useMemo, type ReactNode } from "react";
import { citationMarkdown, splitFileCitations } from "../shared/citations";
import type { ArtifactMessage } from "../shared/contracts";

const stack = { gap: 8, minWidth: 0 };

// SDK Markdown retains Paseo's shared file opener and host/workspace context.
// The math bridge owns prose only: its private renderer rejects local file links.
export function FileArtifactsMessage(
  props: PluginTimelineItemProps<ArtifactMessage> & { renderText?: (text: string) => ReactNode },
) {
  const segments = useMemo(
    () => splitFileCitations(props.item.data.text, props.item.data.streaming),
    [props.item.data.text, props.item.data.streaming],
  );
  const text = useMemo(() => segments.map(citationMarkdown).join(""), [segments]);
  if (!props.renderText) return <Markdown>{text}</Markdown>;
  let position = 0;
  return (
    <View style={stack}>
      {segments.map((segment) => {
        const key = `segment:${position++}`;
        if (segment.kind === "text")
          return <View key={key}>{props.renderText!(segment.text)}</View>;
        return <Markdown key={key}>{citationMarkdown(segment)}</Markdown>;
      })}
    </View>
  );
}
