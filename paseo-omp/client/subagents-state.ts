import { OMP_SUBAGENT_STEER_MAX_LENGTH, type OmpSubagent } from "../shared/subagents";

export interface SubagentNotice {
  tone: "success" | "muted" | "error";
  message: string;
}

/**
 * One subagent at a time owns the inline confirmation, steering draft, or pending request. The
 * state keeps that subagent's last listed row, so its draft and outcome stay visible after it
 * leaves the roster.
 */
export type SubagentPanelState =
  | { kind: "idle"; notice: SubagentNotice | null }
  | { kind: "confirming-cancel"; subagent: OmpSubagent }
  | { kind: "steering"; subagent: OmpSubagent; draft: string; error: string | null }
  | { kind: "cancelling"; subagent: OmpSubagent }
  | { kind: "sending"; subagent: OmpSubagent; draft: string };

export type SubagentPanelAction =
  | { type: "request-cancel"; subagent: OmpSubagent }
  | { type: "start-steer"; subagent: OmpSubagent }
  | { type: "edit-draft"; draft: string }
  | { type: "dismiss" }
  | { type: "submit" }
  | { type: "cancelled"; cancelled: boolean }
  | { type: "steered" }
  | { type: "failed"; message: string };

export const INITIAL_SUBAGENT_PANEL_STATE: SubagentPanelState = { kind: "idle", notice: null };

export function steerDraftProblem(draft: string): string | null {
  if (!draft.trim()) return "Enter a message for the subagent";
  if (draft.trim().length > OMP_SUBAGENT_STEER_MAX_LENGTH) {
    return `Shorten the message to ${OMP_SUBAGENT_STEER_MAX_LENGTH} characters or fewer`;
  }
  return null;
}

/** The host's RPC error keeps the handler's text in `userMessage`, without transport details. */
export function subagentRequestError(cause: unknown): string {
  if (cause instanceof Error) {
    const userMessage: unknown = Reflect.get(cause, "userMessage");
    return typeof userMessage === "string" && userMessage ? userMessage : cause.message;
  }
  return "The OMP subagent request failed";
}

/** The one line under the list: the last outcome, or the open draft's error. */
export function subagentStatusNotice(state: SubagentPanelState): SubagentNotice | null {
  if (state.kind === "idle") return state.notice;
  if (state.kind === "steering" && state.error) return { tone: "error", message: state.error };
  return null;
}

export function isSubagentRequestPending(
  state: SubagentPanelState,
): state is Extract<SubagentPanelState, { kind: "cancelling" | "sending" }> {
  return state.kind === "cancelling" || state.kind === "sending";
}

/**
 * The request a submit starts from this state, or `null` when it starts none. A submit while a
 * request is pending starts nothing, so a repeated press cannot send a second steering message.
 */
export function requestedSubmission(
  state: SubagentPanelState,
): Extract<SubagentPanelState, { kind: "cancelling" | "sending" }> | null {
  if (isSubagentRequestPending(state)) return null;
  const next = subagentPanelReducer(state, { type: "submit" });
  return isSubagentRequestPending(next) ? next : null;
}

export function subagentPanelReducer(
  state: SubagentPanelState,
  action: SubagentPanelAction,
): SubagentPanelState {
  if (isSubagentRequestPending(state)) return settle(state, action);
  switch (action.type) {
    case "request-cancel":
      return { kind: "confirming-cancel", subagent: action.subagent };
    case "start-steer":
      return { kind: "steering", subagent: action.subagent, draft: "", error: null };
    case "edit-draft":
      return state.kind === "steering" ? { ...state, draft: action.draft, error: null } : state;
    case "dismiss":
      return INITIAL_SUBAGENT_PANEL_STATE;
    case "submit":
      if (state.kind === "confirming-cancel") {
        return { kind: "cancelling", subagent: state.subagent };
      }
      if (state.kind === "steering") {
        const problem = steerDraftProblem(state.draft);
        return problem
          ? { ...state, error: problem }
          : { kind: "sending", subagent: state.subagent, draft: state.draft };
      }
      return state;
    default:
      return state;
  }
}

function settle(
  state: Extract<SubagentPanelState, { kind: "cancelling" | "sending" }>,
  action: SubagentPanelAction,
): SubagentPanelState {
  if (state.kind === "cancelling" && action.type === "cancelled") {
    return {
      kind: "idle",
      notice: action.cancelled
        ? { tone: "success", message: "Subagent cancelled" }
        : { tone: "muted", message: "The subagent had already finished" },
    };
  }
  if (state.kind === "sending" && action.type === "steered") {
    return { kind: "idle", notice: { tone: "success", message: "Message sent to the subagent" } };
  }
  if (action.type !== "failed") return state;
  if (state.kind === "sending") {
    return {
      kind: "steering",
      subagent: state.subagent,
      draft: state.draft,
      error: action.message,
    };
  }
  return { kind: "idle", notice: { tone: "error", message: action.message } };
}
