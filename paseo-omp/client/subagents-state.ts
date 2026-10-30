import { OMP_SUBAGENT_STEER_MAX_LENGTH } from "../shared/subagents";

export interface SubagentNotice {
  tone: "success" | "muted" | "error";
  message: string;
}

/** One subagent at a time owns the inline confirmation, steering draft, or pending request. */
export type SubagentPanelState =
  | { kind: "idle"; notice: SubagentNotice | null }
  | { kind: "confirming-cancel"; subagentId: string }
  | { kind: "steering"; subagentId: string; draft: string; error: string | null }
  | { kind: "cancelling"; subagentId: string }
  | { kind: "sending"; subagentId: string; draft: string };

export type SubagentPanelAction =
  | { type: "request-cancel"; subagentId: string }
  | { type: "start-steer"; subagentId: string }
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

export function isSubagentRequestPending(
  state: SubagentPanelState,
): state is Extract<SubagentPanelState, { kind: "cancelling" | "sending" }> {
  return state.kind === "cancelling" || state.kind === "sending";
}

export function subagentPanelReducer(
  state: SubagentPanelState,
  action: SubagentPanelAction,
): SubagentPanelState {
  if (isSubagentRequestPending(state)) return settle(state, action);
  switch (action.type) {
    case "request-cancel":
      return { kind: "confirming-cancel", subagentId: action.subagentId };
    case "start-steer":
      return { kind: "steering", subagentId: action.subagentId, draft: "", error: null };
    case "edit-draft":
      return state.kind === "steering" ? { ...state, draft: action.draft, error: null } : state;
    case "dismiss":
      return INITIAL_SUBAGENT_PANEL_STATE;
    case "submit":
      if (state.kind === "confirming-cancel") {
        return { kind: "cancelling", subagentId: state.subagentId };
      }
      if (state.kind === "steering") {
        const problem = steerDraftProblem(state.draft);
        return problem
          ? { ...state, error: problem }
          : { kind: "sending", subagentId: state.subagentId, draft: state.draft };
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
      subagentId: state.subagentId,
      draft: state.draft,
      error: action.message,
    };
  }
  return { kind: "idle", notice: { tone: "error", message: action.message } };
}
