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
  requestedSubmission,
  type SubagentPanelAction,
  type SubagentPanelState,
  subagentPanelReducer,
  subagentRequestError,
  subagentStatusNotice,
} from "./subagents-state";

const SUBAGENT_POLL_MS = 2_000;

type Theme = PluginHostProps["theme"];

function createStyles(theme: Theme, compact: boolean) {
  return {
    root: { gap: compact ? 8 : 10, width: compact ? undefined : 380 },
    title: { color: theme.colors.foreground, fontSize: 14, fontWeight: "700" as const },
    muted: { color: theme.colors.foregroundMuted, fontSize: 12, lineHeight: 17 },
    error: { color: theme.colors.statusDanger, fontSize: 12, lineHeight: 17 },
    success: { color: theme.colors.statusSuccess, fontSize: 12, lineHeight: 17 },
    // Reserves two lines so a notice or error never grows the popover.
    status: { minHeight: 34 },
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
    state: { color: theme.colors.foregroundMuted, fontSize: 12 },
    // Every mode of a row renders inside this fixed slot, so no action changes the popover's
    // height. The host only re-measures popover content intermittently after it first opens.
    actions: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      gap: 7,
      height: 34,
    },
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
      flex: 1,
      height: 32,
      color: theme.colors.foreground,
      borderWidth: 1,
      borderColor: theme.colors.border,
      borderRadius: 8,
      backgroundColor: theme.colors.surface0,
      paddingHorizontal: 10,
      fontSize: 13,
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
    const request = requestedSubmission(state);
    dispatch({ type: "submit" });
    if (!request) return;
    try {
      if (request.kind === "cancelling") {
        const result = await cancel({ agentId, subagentId: request.subagent.id });
        dispatch({ type: "cancelled", cancelled: result.cancelled });
      } else {
        await steer({ agentId, subagentId: request.subagent.id, message: request.draft });
        dispatch({ type: "steered" });
      }
    } catch (cause) {
      dispatch({ type: "failed", message: subagentRequestError(cause) });
    } finally {
      void queryClient.invalidateQueries({ queryKey });
    }
  }

  const items = subagents.data?.subagents ?? [];
  const unlisted =
    state.kind !== "idle" && !items.some((subagent) => subagent.id === state.subagent.id)
      ? state.subagent
      : null;
  return (
    <View style={styles.root}>
      <Text style={styles.title}>OMP subagents</Text>
      <Text style={styles.muted}>
        Cancel stops a subagent and its nested subagents; the parent turn continues. A steering
        message reaches the subagent at its next step.
      </Text>
      {subagents.isLoading ? <Text style={styles.muted}>Loading subagents...</Text> : null}
      {subagents.error ? (
        <Text style={styles.error}>
          {subagents.error instanceof Error
            ? subagents.error.message
            : "Could not list the OMP subagents"}
        </Text>
      ) : null}
      {subagents.isSuccess && items.length === 0 && !unlisted ? (
        <Text style={styles.muted}>No running subagents</Text>
      ) : null}
      {items.map((subagent) => (
        <SubagentCard
          key={subagent.id}
          subagent={subagent}
          listed
          state={state}
          styles={styles}
          dispatch={dispatch}
          submit={submit}
        />
      ))}
      {unlisted ? (
        <SubagentCard
          subagent={unlisted}
          listed={false}
          state={state}
          styles={styles}
          dispatch={dispatch}
          submit={submit}
        />
      ) : null}
      <View style={styles.status}>
        <StatusText state={state} styles={styles} />
      </View>
    </View>
  );
}

function StatusText({ state, styles }: { state: SubagentPanelState; styles: Styles }) {
  const notice = subagentStatusNotice(state);
  if (!notice) return null;
  const style = { success: styles.success, muted: styles.muted, error: styles.error }[notice.tone];
  return (
    <Text
      accessibilityRole={notice.tone === "error" ? "alert" : undefined}
      numberOfLines={2}
      style={style}
    >
      {notice.message}
    </Text>
  );
}

function ActionButton({
  label,
  accessibilityLabel = label,
  styles,
  disabled = false,
  destructive = false,
  onPress,
}: {
  label: string;
  accessibilityLabel?: string;
  styles: Styles;
  disabled?: boolean;
  destructive?: boolean;
  onPress(): void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
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

interface CardProps {
  subagent: OmpSubagent;
  /** False keeps the row that owns the current request visible after it leaves the roster. */
  listed: boolean;
  state: SubagentPanelState;
  styles: Styles;
  dispatch: (action: SubagentPanelAction) => void;
  submit(): Promise<void>;
}

function SubagentCard(props: CardProps) {
  const { subagent, listed, styles } = props;
  return (
    <View style={styles.card}>
      <View style={styles.row}>
        <Text numberOfLines={1} style={styles.name}>
          {subagent.agent}
        </Text>
        <Text style={styles.state}>{listed ? subagent.status : "no longer running"}</Text>
      </View>
      <Text numberOfLines={1} style={styles.muted}>
        {subagent.name}
      </Text>
      {subagent.description ? (
        <Text numberOfLines={2} style={styles.muted}>
          {subagent.description}
        </Text>
      ) : null}
      <View style={styles.actions}>
        <CardActions {...props} />
      </View>
    </View>
  );
}

function CardActions({ subagent, listed, state, styles, dispatch, submit }: CardProps) {
  const pending = isSubagentRequestPending(state);
  const owner = state.kind !== "idle" && state.subagent.id === subagent.id ? state : null;
  if (owner?.kind === "confirming-cancel" || owner?.kind === "cancelling") {
    return (
      <>
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
      </>
    );
  }
  if (owner?.kind === "steering" || owner?.kind === "sending") {
    return (
      <>
        <TextInput
          accessibilityLabel={`Message for ${subagent.agent}`}
          autoFocus
          editable={owner.kind === "steering"}
          maxLength={OMP_SUBAGENT_STEER_MAX_LENGTH}
          onChangeText={(draft) => dispatch({ type: "edit-draft", draft })}
          onSubmitEditing={() => void submit()}
          placeholder="Message for the subagent"
          placeholderTextColor={styles.muted.color}
          style={styles.input}
          value={owner.draft}
        />
        <ActionButton
          label={owner.kind === "sending" ? "Sending..." : "Send"}
          disabled={pending}
          styles={styles}
          onPress={() => void submit()}
        />
        <ActionButton
          label="Close"
          accessibilityLabel="Close steering message"
          disabled={pending}
          styles={styles}
          onPress={() => dispatch({ type: "dismiss" })}
        />
      </>
    );
  }
  if (!listed || !isLiveOmpSubagentStatus(subagent.status)) return null;
  return (
    <>
      <ActionButton
        label="Steer"
        disabled={pending}
        styles={styles}
        onPress={() => dispatch({ type: "start-steer", subagent })}
      />
      <ActionButton
        label="Cancel"
        disabled={pending}
        styles={styles}
        onPress={() => dispatch({ type: "request-cancel", subagent })}
      />
    </>
  );
}
