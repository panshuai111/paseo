import { Text } from "react-native";
import { useCallback, useMemo, useState } from "react";
import { useSettings, type PluginSurfaceProps, type SettingsState } from "@getpaseo/plugin/client";
import {
  SettingsAction,
  SettingsCard,
  SettingsInput,
  SettingsSection,
  SettingsSwitch,
} from "@getpaseo/plugin/client/ui";
import { preferences } from "../shared/prediction";

type ReadySettings = Extract<SettingsState<typeof preferences.schema>, { status: "ready" }>;

function PromptEditor({ settings, onClose }: { settings: ReadySettings; onClose(): void }) {
  const [draft, setDraft] = useState(() => ({
    prompt: settings.values.prompt,
    revision: settings.revision,
  }));
  const change = useCallback((prompt: string) => setDraft((value) => ({ ...value, prompt })), []);
  const save = useCallback(async () => {
    if (await settings.save({ ...settings.values, prompt: draft.prompt }, draft.revision))
      onClose();
  }, [settings, draft, onClose]);
  return (
    <SettingsCard>
      <SettingsInput
        label="预测提示词 / Prediction prompt"
        initialValue={draft.prompt}
        onChangeText={change}
        disabled={settings.saving}
        error={settings.saveError}
      />
      <SettingsAction
        label="保存提示词 / Save prompt"
        actionLabel="保存 / Save"
        disabled={settings.saving}
        onPress={save}
      />
      <SettingsAction
        label="取消修改 / Discard changes"
        actionLabel="取消 / Cancel"
        disabled={settings.saving}
        onPress={onClose}
      />
    </SettingsCard>
  );
}

function Controls({ settings }: { settings: ReadySettings }) {
  const [editing, setEditing] = useState(false);
  const toggle = useCallback(
    (enabled: boolean) => {
      void settings.save({ ...settings.values, enabled }, settings.revision);
    },
    [settings],
  );
  const open = useCallback(() => setEditing(true), []);
  const close = useCallback(() => setEditing(false), []);
  return (
    <>
      <SettingsCard>
        <SettingsSwitch
          label="自动生成下一句建议 / Enable suggestions"
          value={settings.values.enabled}
          disabled={settings.saving}
          onValueChange={toggle}
        />
        <SettingsAction
          label="预测提示词 / Prediction prompt"
          actionLabel="编辑 / Edit"
          onPress={open}
        />
      </SettingsCard>
      {editing && <PromptEditor settings={settings} onClose={close} />}
    </>
  );
}

export function Settings({ theme }: PluginSurfaceProps) {
  const settings = useSettings(preferences);
  const style = useMemo(() => ({ color: theme.colors.foregroundMuted }), [theme]);
  const reload = useCallback(() => {
    void settings.reload();
  }, [settings]);
  const reset = useCallback(() => {
    void settings.reset();
  }, [settings]);
  if (settings.status === "loading")
    return <Text style={style}>正在加载设置 / Loading settings…</Text>;
  if (settings.status !== "ready")
    return (
      <SettingsSection title="回复建议 / Reply suggestions">
        <Text style={style}>{settings.error}</Text>
        <SettingsAction label="重新加载 / Reload" actionLabel="重试 / Retry" onPress={reload} />
        <SettingsAction
          label="恢复默认设置 / Reset settings"
          actionLabel="重置 / Reset"
          onPress={reset}
        />
      </SettingsSection>
    );
  return (
    <SettingsSection title="回复建议 / Reply suggestions">
      <Controls settings={settings} />
      <Text style={style}>
        当前会话回复结束且输入框为空时生成。沿用当前 Codex
        模型；采用后成为草稿，由你发送。设置应用于下一次请求，预测会产生模型请求。
      </Text>
    </SettingsSection>
  );
}
