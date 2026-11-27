import { useRpc, type PluginFile, type PluginFilePanelProps } from "@getpaseo/plugin/client";
import { copyText } from "@getpaseo/plugin/client/ui";
import type { PluginTheme } from "@getpaseo/plugin";
import { useMemo, useCallback, useState } from "react";
import { Pressable, View, Text } from "react-native";
import { inspectTarget, readTarget, MAX_DOWNLOAD_BYTES } from "../shared/contracts";
import type { PreviewTarget } from "../shared/preview";
import { saveDownload } from "./web";

function Action({
  label,
  theme,
  onPress,
  disabled = false,
}: {
  label: string;
  theme: PluginTheme;
  onPress(): void;
  disabled?: boolean;
}) {
  const box = useMemo(() => ({ padding: 8, opacity: disabled ? 0.4 : 1 }), [disabled]);
  const text = useMemo(() => ({ color: theme.colors.accent }), [theme]);
  return (
    <Pressable accessibilityRole="button" disabled={disabled} onPress={onPress} style={box}>
      <Text style={text}>{label}</Text>
    </Pressable>
  );
}

export function ArtifactFileToolbar({
  target,
  file,
  theme,
  platform,
}: {
  target: PreviewTarget;
  file: PluginFile;
  theme: PluginTheme;
  platform: string;
}) {
  const inspect = useRpc(inspectTarget);
  const read = useRpc(readTarget);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const s = useMemo(
    () => ({
      bar: { padding: 8, borderBottomWidth: 1, borderColor: theme.colors.border },
      row: {
        flexDirection: "row" as const,
        flexWrap: "wrap" as const,
        alignItems: "center" as const,
        gap: 6,
      },
      text: { color: theme.colors.foregroundMuted, paddingHorizontal: 8 },
    }),
    [theme],
  );
  const copy = useCallback(() => {
    void copyText(file.path).then(
      () => setNotice("路径已复制。"),
      () => setNotice("复制失败。"),
    );
  }, [file]);
  const download = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setNotice("");
    try {
      const info = await inspect(target);
      if (info.status !== "ready") throw new Error(info.message);
      const bytes = await read({ target, size: info.size, modifiedAt: info.modifiedAt });
      saveDownload(bytes.base64, bytes.name);
      setNotice("已发起下载。");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "下载失败，请重试。");
    } finally {
      setBusy(false);
    }
  }, [busy, inspect, target, read]);
  const size = file.size < 1024 ? `${file.size} B` : `${(file.size / 1024 ** 2).toFixed(2)} MiB`;
  return (
    <View style={s.bar}>
      <View style={s.row}>
        <Text style={s.text}>{size}</Text>
        <Action theme={theme} label="复制路径" onPress={copy} />
        {platform === "web" ? (
          <Action
            theme={theme}
            label={busy ? "正在下载…" : "下载原文件"}
            onPress={download}
            disabled={busy || file.size > MAX_DOWNLOAD_BYTES}
          />
        ) : null}
      </View>
      {file.size > MAX_DOWNLOAD_BYTES ? (
        <Text style={s.text}>原文件下载上限为 32 MiB。</Text>
      ) : null}
      {notice ? (
        <Text accessibilityLiveRegion="polite" style={s.text}>
          {notice}
        </Text>
      ) : null}
    </View>
  );
}

export const DOWNLOAD_EXTENSIONS = ["zip", "7z", "rar", "tar", "gz", "bz2", "xz", "parquet"];
export function ArtifactDownloadPanel({ file, workspaceId, theme, layout }: PluginFilePanelProps) {
  const target = useMemo<PreviewTarget>(
    () => ({ kind: "workspace", id: workspaceId, path: file.path }),
    [workspaceId, file.path],
  );
  const style = useMemo(() => ({ color: theme.colors.foregroundMuted, padding: 16 }), [theme]);
  return (
    <View>
      <ArtifactFileToolbar target={target} file={file} theme={theme} platform={layout.platform} />
      <Text selectable style={style}>
        此格式暂不支持内容预览，请下载原文件查看。
      </Text>
    </View>
  );
}
