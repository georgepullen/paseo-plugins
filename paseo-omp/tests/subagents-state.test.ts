import { describe, expect, test } from "vitest";
import {
  INITIAL_SUBAGENT_PANEL_STATE,
  isSubagentRequestPending,
  requestedSubmission,
  type SubagentPanelAction,
  type SubagentPanelState,
  steerDraftProblem,
  subagentPanelReducer,
  subagentRequestError,
  subagentStatusNotice,
} from "../client/subagents-state";
import {
  cancelOmpSubagent,
  isLiveOmpSubagentStatus,
  listOmpSubagents,
  OMP_SUBAGENT_STEER_MAX_LENGTH,
  OmpSubagentStatusSchema,
  steerOmpSubagent,
} from "../shared/subagents";

const CHILD = {
  id: "opaque-handle-1",
  name: "child-1",
  agent: "worker",
  description: null,
  status: "running" as const,
};
const OTHER = { ...CHILD, id: "opaque-handle-2", name: "child-2" };

function run(...actions: SubagentPanelAction[]): SubagentPanelState {
  return actions.reduce(subagentPanelReducer, INITIAL_SUBAGENT_PANEL_STATE);
}

describe("OMP subagent panel state", () => {
  test("cancel requires a confirmation and reports idempotent outcomes", () => {
    const confirming = run({ type: "request-cancel", subagent: CHILD });
    expect(confirming).toEqual({ kind: "confirming-cancel", subagent: CHILD });
    expect(subagentPanelReducer(confirming, { type: "dismiss" })).toEqual(
      INITIAL_SUBAGENT_PANEL_STATE,
    );
    const cancelling = subagentPanelReducer(confirming, { type: "submit" });
    expect(cancelling).toEqual({ kind: "cancelling", subagent: CHILD });
    expect(isSubagentRequestPending(cancelling)).toBe(true);
    expect(subagentPanelReducer(cancelling, { type: "cancelled", cancelled: true })).toEqual({
      kind: "idle",
      notice: { tone: "success", message: "Subagent cancelled" },
    });
    expect(subagentPanelReducer(cancelling, { type: "cancelled", cancelled: false })).toEqual({
      kind: "idle",
      notice: { tone: "muted", message: "The subagent had already finished" },
    });
    expect(
      subagentPanelReducer(cancelling, { type: "failed", message: "OMP could not cancel" }),
    ).toEqual({ kind: "idle", notice: { tone: "error", message: "OMP could not cancel" } });
  });

  test("steering validates the draft and keeps it after a failed send", () => {
    const empty = run({ type: "start-steer", subagent: CHILD }, { type: "submit" });
    expect(empty).toEqual({
      kind: "steering",
      subagent: CHILD,
      draft: "",
      error: "Enter a message for the subagent",
    });
    const sending = run(
      { type: "start-steer", subagent: CHILD },
      { type: "edit-draft", draft: "Focus on the parser" },
      { type: "submit" },
    );
    expect(sending).toEqual({
      kind: "sending",
      subagent: CHILD,
      draft: "Focus on the parser",
    });
    expect(subagentPanelReducer(sending, { type: "steered" })).toEqual({
      kind: "idle",
      notice: { tone: "success", message: "Message sent to the subagent" },
    });
    expect(
      subagentPanelReducer(sending, {
        type: "failed",
        message: "This subagent is no longer running",
      }),
    ).toEqual({
      kind: "steering",
      subagent: CHILD,
      draft: "Focus on the parser",
      error: "This subagent is no longer running",
    });
  });

  test("shows one status line for the last outcome or the open draft's error", () => {
    expect(subagentStatusNotice(INITIAL_SUBAGENT_PANEL_STATE)).toBeNull();
    const failed = run(
      { type: "start-steer", subagent: CHILD },
      { type: "edit-draft", draft: "focus" },
      { type: "submit" },
      { type: "failed", message: "OMP did not accept the message" },
    );
    expect(subagentStatusNotice(failed)).toEqual({
      tone: "error",
      message: "OMP did not accept the message",
    });
    expect(subagentStatusNotice(subagentPanelReducer(failed, { type: "submit" }))).toBeNull();
    expect(
      subagentStatusNotice(
        run(
          { type: "request-cancel", subagent: CHILD },
          { type: "submit" },
          {
            type: "cancelled",
            cancelled: true,
          },
        ),
      ),
    ).toEqual({ tone: "success", message: "Subagent cancelled" });
    expect(subagentStatusNotice(run({ type: "request-cancel", subagent: CHILD }))).toBeNull();
  });

  test("shows the handler's message without transport details", () => {
    const rpcError = Object.assign(
      new Error(
        "Request failed: This subagent is no longer running requestType=plugin.rpc.invoke.request code=handler_error",
      ),
      { userMessage: "Request failed: This subagent is no longer running" },
    );
    expect(subagentRequestError(rpcError)).toBe(
      "Request failed: This subagent is no longer running",
    );
    expect(subagentRequestError(new Error("offline"))).toBe("offline");
    expect(subagentRequestError("boom")).toBe("The OMP subagent request failed");
  });

  test("starts at most one request per submission", () => {
    const confirming = run({ type: "request-cancel", subagent: CHILD });
    expect(requestedSubmission(confirming)).toEqual({ kind: "cancelling", subagent: CHILD });
    const steering = run({ type: "start-steer", subagent: CHILD });
    expect(requestedSubmission(steering)).toBeNull();
    const drafted = subagentPanelReducer(steering, { type: "edit-draft", draft: "focus" });
    const sending = requestedSubmission(drafted);
    expect(sending).toEqual({ kind: "sending", subagent: CHILD, draft: "focus" });
    if (!sending) throw new Error("Expected a steering request");
    expect(requestedSubmission(sending)).toBeNull();
    expect(requestedSubmission(subagentPanelReducer(confirming, { type: "submit" }))).toBeNull();
    expect(requestedSubmission(INITIAL_SUBAGENT_PANEL_STATE)).toBeNull();
  });

  test("ignores new requests and unrelated outcomes while a request is pending", () => {
    const sending = run(
      { type: "start-steer", subagent: CHILD },
      { type: "edit-draft", draft: "focus" },
      { type: "submit" },
    );
    for (const action of [
      { type: "request-cancel", subagent: OTHER },
      { type: "start-steer", subagent: OTHER },
      { type: "edit-draft", draft: "changed" },
      { type: "dismiss" },
      { type: "submit" },
      { type: "cancelled", cancelled: true },
    ] satisfies SubagentPanelAction[]) {
      expect(subagentPanelReducer(sending, action)).toBe(sending);
    }
    expect(subagentPanelReducer(INITIAL_SUBAGENT_PANEL_STATE, { type: "steered" })).toBe(
      INITIAL_SUBAGENT_PANEL_STATE,
    );
    expect(
      subagentPanelReducer(INITIAL_SUBAGENT_PANEL_STATE, { type: "edit-draft", draft: "x" }),
    ).toBe(INITIAL_SUBAGENT_PANEL_STATE);
  });

  test("bounds steering text and identifiers at the RPC contract", () => {
    expect(steerDraftProblem("  ok  ")).toBeNull();
    expect(steerDraftProblem("x".repeat(OMP_SUBAGENT_STEER_MAX_LENGTH + 1))).toBe(
      `Shorten the message to ${OMP_SUBAGENT_STEER_MAX_LENGTH} characters or fewer`,
    );
    expect(
      steerOmpSubagent.input.parse({ agentId: "a", subagentId: "c", message: "  focus  " }),
    ).toEqual({ agentId: "a", subagentId: "c", message: "focus" });
    expect(
      steerOmpSubagent.input.safeParse({ agentId: "a", subagentId: "c", message: " \n " }).success,
    ).toBe(false);
    expect(
      steerOmpSubagent.input.safeParse({
        agentId: "a",
        subagentId: "c",
        message: "x".repeat(OMP_SUBAGENT_STEER_MAX_LENGTH + 1),
      }).success,
    ).toBe(false);
    expect(
      cancelOmpSubagent.input.safeParse({ agentId: "a", subagentId: "x".repeat(257) }).success,
    ).toBe(false);
    expect(listOmpSubagents.input.safeParse({ agentId: "" }).success).toBe(false);
    expect(
      OmpSubagentStatusSchema.options.filter((status) => isLiveOmpSubagentStatus(status)),
    ).toEqual(["pending", "running"]);
  });
});
