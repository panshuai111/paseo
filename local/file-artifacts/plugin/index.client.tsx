import type { PluginClientContext } from "@getpaseo/plugin/client";
import { FileArtifactsMessage } from "./client/message";
import { hasFileCitations } from "./shared/citations";
import { messageSchema } from "./shared/contracts";
import { ArtifactFilePanel } from "./client/preview";
import { ArtifactDownloadPanel, DOWNLOAD_EXTENSIONS } from "./client/toolbar";
import { PREVIEW_EXTENSIONS } from "./shared/preview";

export default function contribute(client: PluginClientContext) {
  client.addFilePanel({
    id: "preview",
    title: "文件预览",
    icon: "FileText",
    files: { extensions: PREVIEW_EXTENSIONS },
    Component: ArtifactFilePanel,
  });
  client.addFilePanel({
    id: "download",
    title: "文件下载",
    icon: "Download",
    files: { extensions: DOWNLOAD_EXTENSIONS },
    Component: ArtifactDownloadPanel,
  });
  client.addTimelineRenderer({
    kind: "file-artifacts",
    version: 1,
    schema: messageSchema,
    Component: FileArtifactsMessage,
  });
  client.addTimelineTransformer({
    id: "file-citations",
    query: { itemType: "assistant_message" },
    transform({ item, phase }) {
      if (!hasFileCitations(item.text)) return undefined;
      return {
        items: [
          {
            type: "plugin",
            kind: "file-artifacts",
            version: 1,
            data: { text: item.text, streaming: phase === "streaming" },
          },
        ],
      };
    },
  });
  return () => {};
}
