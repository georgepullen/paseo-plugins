import {
  type PluginButtonContentProps,
  type PluginHostProps,
  useAgent,
  useRpc,
} from "@getpaseo/plugin/client";
import { TextInput } from "@getpaseo/plugin/client/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useReducer } from "react";
import { Pressable, Text, View } from "react-native";
import {
  cancelOmpSubagent,
  isLiveOmpSubagentStatus,
  listOmpSubagents,
  OMP_SUBAGENT_STEER_MAX_LENGTH,
  type OmpSubagent,
  steerOmpSubagent,
} from "../shared/subagents";
import { isOmpPluginProvider } from "./omp-store-state";
import {
  INITIAL_SUBAGENT_PANEL_STATE,
  isSubagentRequestPending,
  type SubagentNotice,
  type SubagentPanelAction,
  type SubagentPanelState,
  subagentPanelReducer,
} from "./subagents-state";

const SUBAGENT_POLL_MS = 2_000;

type Theme = PluginHostProps["theme"];

function createStyles(theme: Theme, compact: boolean) {
  return {
    root: { gap: compact ? 8 : 10, width: compact ? undefined : 380 },
    title: { color: theme.colors.foreground, fontSize: 14, fontWeight: "700" as const },
    muted: { color: theme.colors.foregroundMuted, fontSize: 12, lineHeight: 17 },
    error: { color: theme.colors.statusDanger, fontSize: 12 },
    success: { color: theme.colors.statusSuccess, fontSize: 12 },
    card: {
      gap: 6,
      padding: compact ? 10 : 12,
      borderRadius: 10,
      borderWidth: 1,
      borderColor: theme.colors.border,
      backgroundColor: theme.colors.surface1,
    },
    row: { flexDirection: "row" as const, justifyContent: "space-between" as const, gap: 12 },
    name: { color: theme.colors.foreground, fontSize: 14, fontWeight: "600" as const, flex: 1 },
    status: { color: theme.colors.foregroundMuted, fontSize: 12 },
    actions: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 7 },
    action: {
      paddingHorizontal: 10,
      paddingVertical: 6,
      borderWidth: 1,
      borderColor: theme.colors.border,
      borderRadius: 8,
      backgroundColor: theme.colors.surface0,
    },
    destructive: { borderColor: theme.colors.statusDanger },
    actionDisabled: { opacity: 0.45 },
    actionText: { color: theme.colors.foreground, fontSize: 12, fontWeight: "600" as const },
    destructiveText: { color: theme.colors.statusDanger },
    input: {
      color: theme.colors.foreground,
      borderWidth: 1,
      borderColor: theme.colors.border,
      borderRadius: 8,
      backgroundColor: theme.colors.surface0,
      paddingHorizontal: 10,
      paddingVertical: 8,
      fontSize: 13,
      minHeight: 64,
    },
  };
}

type Styles = ReturnType<typeof createStyles>;

export function SubagentsPopover(props: PluginButtonContentProps) {
  const agentId = props.context === "agent" ? props.agentId : "";
  const provider = useAgent(agentId, (agent) => agent.provider);
  const styles = useMemo(
    () => createStyles(props.theme, props.layout.compact),
    [props.layout.compact, props.theme],
  );
  if (!isOmpPluginProvider(provider ?? undefined)) {
    return <Text style={styles.muted}>Subagent controls require an OMP Plugin agent.</Text>;
  }
  return <SubagentList agentId={agentId} styles={styles} />;
}

function SubagentList({ agentId, styles }: { agentId: string; styles: Styles }) {
  const list = useRpc(listOmpSubagents);
  const cancel = useRpc(cancelOmpSubagent);
  const steer = useRpc(steerOmpSubagent);
  const queryClient = useQueryClient();
  const queryKey = ["paseo-omp", "subagents", agentId];
  const subagents = useQuery({
    queryKey,
    queryFn: () => list({ agentId }),
    refetchInterval: SUBAGENT_POLL_MS,
  });
  const [state, dispatch] = useReducer(subagentPanelReducer, INITIAL_SUBAGENT_PANEL_STATE);

  async function submit(): Promise<void> {
    const next = subagentPanelReducer(state, { type: "submit" });
    dispatch({ type: "submit" });
    if (next.kind !== "cancelling" && next.kind !== "sending") return;
    try {
      if (next.kind === "cancelling") {
        const result = await cancel({ agentId, subagentId: next.subagentId });
        dispatch({ type: "cancelled", cancelled: result.cancelled });
      } else {
        await steer({ agentId, subagentId: next.subagentId, message: next.draft });
        dispatch({ type: "steered" });
      }
    } catch (cause) {
      dispatch({
        type: "failed",
        message: cause instanceof Error ? cause.message : "The OMP subagent request failed",
      });
    } finally {
      void queryClient.invalidateQueries({ queryKey });
    }
  }

  const items = subagents.data?.subagents ?? [];
  return (
    <View style={styles.root}>
      <Text style={styles.title}>OMP subagents</Text>
      {subagents.isLoading ? <Text style={styles.muted}>Loading subagents...</Text> : null}
      {subagents.error ? (
        <Text style={styles.error}>
          {subagents.error instanceof Error
            ? subagents.error.message
            : "Could not list the OMP subagents"}
        </Text>
      ) : null}
      {subagents.isSuccess && items.length === 0 ? (
        <Text style={styles.muted}>No running subagents</Text>
      ) : null}
      {items.map((subagent) => (
        <SubagentCard
          key={subagent.id}
          subagent={subagent}
          state={state}
          styles={styles}
          dispatch={dispatch}
          submit={submit}
        />
      ))}
      {state.kind === "idle" && state.notice ? (
        <NoticeText notice={state.notice} styles={styles} />
      ) : null}
    </View>
  );
}

function NoticeText({ notice, styles }: { notice: SubagentNotice; styles: Styles }) {
  const style = { success: styles.success, muted: styles.muted, error: styles.error }[notice.tone];
  return (
    <Text accessibilityRole={notice.tone === "error" ? "alert" : undefined} style={style}>
      {notice.message}
    </Text>
  );
}

function ActionButton({
  label,
  styles,
  disabled = false,
  destructive = false,
  onPress,
}: {
  label: string;
  styles: Styles;
  disabled?: boolean;
  destructive?: boolean;
  onPress(): void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      style={[
        styles.action,
        destructive ? styles.destructive : null,
        disabled ? styles.actionDisabled : null,
      ]}
    >
      <Text style={[styles.actionText, destructive ? styles.destructiveText : null]}>{label}</Text>
    </Pressable>
  );
}

function SubagentCard({
  subagent,
  state,
  styles,
  dispatch,
  submit,
}: {
  subagent: OmpSubagent;
  state: SubagentPanelState;
  styles: Styles;
  dispatch: (action: SubagentPanelAction) => void;
  submit(): Promise<void>;
}) {
  const live = isLiveOmpSubagentStatus(subagent.status);
  const pending = isSubagentRequestPending(state);
  const owner = state.kind !== "idle" && state.subagentId === subagent.id ? state : null;
  return (
    <View style={styles.card}>
      <View style={styles.row}>
        <Text numberOfLines={1} style={styles.name}>
          {subagent.agent}
        </Text>
        <Text style={styles.status}>{subagent.status}</Text>
      </View>
      <Text numberOfLines={1} style={styles.muted}>
        {subagent.id}
      </Text>
      {subagent.description ? (
        <Text numberOfLines={2} style={styles.muted}>
          {subagent.description}
        </Text>
      ) : null}
      {owner?.kind === "confirming-cancel" || owner?.kind === "cancelling" ? (
        <View accessibilityRole="alert" style={styles.card}>
          <Text style={styles.muted}>
            OMP stops this subagent and its nested subagents. The parent turn continues and receives
            an aborted result.
          </Text>
          <View style={styles.actions}>
            <ActionButton
              label={owner.kind === "cancelling" ? "Cancelling..." : "Cancel subagent"}
              destructive
              disabled={pending}
              styles={styles}
              onPress={() => void submit()}
            />
            <ActionButton
              label="Keep running"
              disabled={pending}
              styles={styles}
              onPress={() => dispatch({ type: "dismiss" })}
            />
          </View>
        </View>
      ) : null}
      {owner?.kind === "steering" || owner?.kind === "sending" ? (
        <View style={styles.card}>
          <TextInput
            accessibilityLabel={`Message for ${subagent.agent}`}
            autoFocus
            editable={owner.kind === "steering"}
            maxLength={OMP_SUBAGENT_STEER_MAX_LENGTH}
            multiline
            onChangeText={(draft) => dispatch({ type: "edit-draft", draft })}
            placeholder="Message the subagent receives as its user"
            placeholderTextColor={styles.muted.color}
            style={styles.input}
            value={owner.draft}
          />
          <Text style={styles.muted}>
            The subagent receives this at its next step. Slash commands run in the subagent.
          </Text>
          {owner.kind === "steering" && owner.error ? (
            <Text accessibilityRole="alert" style={styles.error}>
              {owner.error}
            </Text>
          ) : null}
          <View style={styles.actions}>
            <ActionButton
              label={owner.kind === "sending" ? "Sending..." : "Send"}
              disabled={pending}
              styles={styles}
              onPress={() => void submit()}
            />
            <ActionButton
              label="Close"
              disabled={pending}
              styles={styles}
              onPress={() => dispatch({ type: "dismiss" })}
            />
          </View>
        </View>
      ) : null}
      {live && !owner ? (
        <View style={styles.actions}>
          <ActionButton
            label="Steer"
            disabled={pending}
            styles={styles}
            onPress={() => dispatch({ type: "start-steer", subagentId: subagent.id })}
          />
          <ActionButton
            label="Cancel"
            disabled={pending}
            styles={styles}
            onPress={() => dispatch({ type: "request-cancel", subagentId: subagent.id })}
          />
        </View>
      ) : null}
    </View>
  );
}
