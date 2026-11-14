import { useCallback, useEffect, useMemo, useState } from "react";
import { Text, View } from "react-native";
import {
  useSettings,
  useTranslation,
  type PluginSurfaceProps,
  type SettingsState,
} from "@getpaseo/plugin/client";
import {
  ScrollView,
  SettingsAction,
  SettingsCard,
  SettingsInput,
  SettingsRow,
  SettingsSection,
  SettingsSwitch,
  TextInput,
  useToast,
} from "@getpaseo/plugin/client/ui";
import { antigravitySettings, DEFAULT_READ_ONLY_ROOTS } from "../shared/settings";
import { messages } from "./messages";

type ReadySettings = Extract<SettingsState<typeof antigravitySettings.schema>, { status: "ready" }>;

function SettingsEditor({ settings, theme }: { settings: ReadySettings; theme: PluginSurfaceProps["theme"] }) {
  const { t } = useTranslation(messages);
  const toast = useToast();
  const [agyPath, setAgyPath] = useState(settings.values.agyPath);
  const [timeoutText, setTimeoutText] = useState(String(settings.values.backgroundTimeoutMinutes));
  const [rootsText, setRootsText] = useState(settings.values.readOnlyRoots.join("\n"));

  useEffect(() => {
    setAgyPath(settings.values.agyPath);
    setTimeoutText(String(settings.values.backgroundTimeoutMinutes));
    setRootsText(settings.values.readOnlyRoots.join("\n"));
  }, [settings.revision, settings.values]);

  const styles = useMemo(
    () => ({
      container: { padding: 16, gap: 16 },
      muted: { color: theme.colors.foregroundMuted, fontSize: 12, lineHeight: 18 },
      code: {
        color: theme.colors.foreground,
        fontSize: 12,
        lineHeight: 18,
        paddingVertical: 2,
      },
      multiline: {
        minHeight: 96,
        padding: 10,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface1,
        color: theme.colors.foreground,
        fontSize: 13,
        textAlignVertical: "top" as const,
      },
      error: { color: theme.colors.statusDanger, fontSize: 12 },
    }),
    [theme],
  );

  const toggleProgress = useCallback(
    (progressUpdates: boolean) => {
      void settings.save({ ...settings.values, progressUpdates }, settings.revision);
    },
    [settings],
  );

  const handleSave = useCallback(async () => {
    const parsedMinutes = Number.parseInt(timeoutText.trim(), 10);
    const backgroundTimeoutMinutes = Number.isFinite(parsedMinutes)
      ? Math.min(1440, Math.max(1, parsedMinutes))
      : settings.values.backgroundTimeoutMinutes;
    const readOnlyRoots = rootsText
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    const ok = await settings.save(
      {
        ...settings.values,
        agyPath: agyPath.trim(),
        backgroundTimeoutMinutes,
        readOnlyRoots,
      },
      settings.revision,
    );
    if (ok) toast.show(t("savedToast"), { variant: "success" });
  }, [agyPath, rootsText, settings, t, timeoutText, toast]);

  const handleReset = useCallback(async () => {
    await settings.reset();
  }, [settings]);

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <SettingsSection title={t("runtimeSection")}>
        <SettingsCard>
          <SettingsInput
            label={t("agyPathLabel")}
            hint={t("agyPathHint")}
            placeholder={t("agyPathPlaceholder")}
            initialValue={agyPath}
            onChangeText={setAgyPath}
            disabled={settings.saving}
          />
          <SettingsSwitch
            label={t("progressUpdatesLabel")}
            hint={t("progressUpdatesHint")}
            value={settings.values.progressUpdates}
            disabled={settings.saving}
            onValueChange={toggleProgress}
          />
          <SettingsInput
            label={t("timeoutLabel")}
            hint={t("timeoutHint")}
            placeholder="60"
            initialValue={timeoutText}
            onChangeText={setTimeoutText}
            disabled={settings.saving}
          />
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title={t("readOnlySection")}>
        <SettingsCard>
          <SettingsRow label={t("builtInRootsLabel")} hint={t("builtInRootsHint")}>
            <View>
              {DEFAULT_READ_ONLY_ROOTS.map((root) => (
                <Text key={root} style={styles.code}>
                  {root}
                </Text>
              ))}
            </View>
          </SettingsRow>
          <SettingsRow label={t("extraRootsLabel")} hint={t("extraRootsHint")}>
            <TextInput
              multiline
              value={rootsText}
              onChangeText={setRootsText}
              placeholder={t("extraRootsPlaceholder")}
              placeholderTextColor={theme.colors.foregroundMuted}
              editable={!settings.saving}
              style={styles.multiline}
            />
          </SettingsRow>
          <SettingsAction
            label={t("saveLabel")}
            actionLabel={t("saveAction")}
            disabled={settings.saving}
            onPress={() => {
              void handleSave();
            }}
          />
          <SettingsAction
            label={t("resetLabel")}
            actionLabel={t("resetAction")}
            disabled={settings.saving}
            onPress={() => {
              void handleReset();
            }}
          />
        </SettingsCard>
      </SettingsSection>

      {settings.saveError ? <Text style={styles.error}>{settings.saveError}</Text> : null}
    </ScrollView>
  );
}

export function AntigravitySettingsScreen({ theme }: PluginSurfaceProps) {
  const settings = useSettings(antigravitySettings);
  const textStyle = useMemo(() => ({ padding: 20, color: theme.colors.foreground }), [theme]);

  if (settings.status === "loading") {
    return <Text style={textStyle}>Loading…</Text>;
  }
  if (settings.status === "error" || settings.status === "invalid") {
    return <Text style={{ ...textStyle, color: theme.colors.statusDanger }}>{settings.error}</Text>;
  }
  return <SettingsEditor settings={settings} theme={theme} />;
}
