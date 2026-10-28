import { type PluginSurfaceProps, type SettingsState, useSettings } from "@getpaseo/plugin/client";
import {
  SettingsAction,
  SettingsCard,
  SettingsInput,
  SettingsSection,
} from "@getpaseo/plugin/client/ui";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Text, View } from "react-native";
import {
  MAX_SESSIONS_UPPER_BOUND,
  providerLaunchSettings,
  providerLaunchSettingsSchema,
} from "../shared/provider-launch-settings";

type ReadySettings = Extract<
  SettingsState<typeof providerLaunchSettings.schema>,
  { status: "ready" }
>;

function ProviderLaunchSettingsControls({ settings }: { settings: ReadySettings }) {
  const savedNames = settings.values.inheritEnv.join(", ");
  const [rawNames, setRawNames] = useState(() => savedNames);
  useEffect(() => {
    setRawNames(savedNames);
  }, [savedNames]);
  const savedMaxSessions = String(settings.values.maxSessions);
  const [rawMaxSessions, setRawMaxSessions] = useState(() => savedMaxSessions);
  useEffect(() => {
    setRawMaxSessions(savedMaxSessions);
  }, [savedMaxSessions]);
  const inheritEnv = [
    ...new Set(
      rawNames
        .split(",")
        .map((name) => name.trim())
        .filter(Boolean),
    ),
  ];
  const next = providerLaunchSettingsSchema.safeParse({ ...settings.values, inheritEnv });
  const error = next.success
    ? null
    : (next.error.issues[0]?.message ?? "Enter valid variable names.");
  const save = useCallback(async () => {
    if (!next.success) return;
    await settings.save(next.data, settings.revision);
  }, [next, settings]);
  const nextMaxSessions = providerLaunchSettingsSchema.safeParse({
    ...settings.values,
    maxSessions: Number(rawMaxSessions.trim()),
  });
  const saveMaxSessions = useCallback(async () => {
    if (!nextMaxSessions.success) return;
    await settings.save(nextMaxSessions.data, settings.revision);
  }, [nextMaxSessions, settings]);

  return (
    <View style={{ gap: 12 }}>
      <SettingsSection
        title="Inherited environment"
        info="Applies to every OMP Plugin agent on this host. Names are stored, but values are read only from the daemon environment when OMP starts."
      >
        <SettingsCard>
          <SettingsInput
            key={savedNames}
            label="Daemon variable names"
            hint="Comma-separated names. Each selected value is available to OMP and its child processes."
            initialValue={savedNames}
            onChangeText={setRawNames}
            placeholder="ACME_OMP_API_KEY, ACME_OMP_URL"
            error={error ?? undefined}
            disabled={settings.saving}
          />
          <SettingsAction
            label="Save inherited environment"
            hint="Profile-specific names remain additive for narrow exceptions."
            actionLabel="Save"
            disabled={settings.saving || rawNames === savedNames || !next.success}
            onPress={() => void save()}
          />
          <SettingsAction
            label="Clear inherited environment"
            actionLabel="Clear"
            disabled={settings.saving || settings.values.inheritEnv.length === 0}
            onPress={async () => {
              if (await settings.save({ ...settings.values, inheritEnv: [] }, settings.revision)) {
                setRawNames("");
              }
            }}
          />
          {settings.saveError ? (
            <SettingsAction
              label="Reload host launch settings"
              error={settings.saveError}
              actionLabel="Reload"
              disabled={settings.saving}
              onPress={settings.reload}
            />
          ) : null}
        </SettingsCard>
      </SettingsSection>
      <SettingsSection
        title="Session limit"
        info="Applies to all OMP Plugin agents on this host together, including idle ones."
      >
        <SettingsCard>
          <SettingsInput
            key={savedMaxSessions}
            label="Open sessions"
            hint="New OMP Plugin agents are refused while this many sessions are open. Archive idle agents to free sessions."
            initialValue={savedMaxSessions}
            onChangeText={setRawMaxSessions}
            error={
              nextMaxSessions.success
                ? undefined
                : `Enter a whole number from 1 to ${MAX_SESSIONS_UPPER_BOUND}.`
            }
            disabled={settings.saving}
          />
          <SettingsAction
            label="Save session limit"
            actionLabel="Save"
            disabled={
              settings.saving || rawMaxSessions === savedMaxSessions || !nextMaxSessions.success
            }
            onPress={() => void saveMaxSessions()}
          />
        </SettingsCard>
      </SettingsSection>
    </View>
  );
}

export function ProviderLaunchSettingsSection({ theme }: { theme: PluginSurfaceProps["theme"] }) {
  const settings = useSettings(providerLaunchSettings);
  const styles = useMemo(
    () => ({
      root: { gap: 12 },
      text: { color: theme.colors.foreground },
      error: { color: theme.colors.statusDanger },
    }),
    [theme],
  );

  if (settings.status === "loading")
    return <Text style={styles.text}>Loading host launch settings…</Text>;
  if (settings.status !== "ready") {
    return (
      <View style={styles.root}>
        <Text accessibilityRole="alert" style={styles.error}>
          {settings.error}
        </Text>
        <SettingsAction
          label="Read host launch settings again"
          actionLabel="Reload"
          onPress={settings.reload}
        />
      </View>
    );
  }
  return <ProviderLaunchSettingsControls settings={settings} />;
}
