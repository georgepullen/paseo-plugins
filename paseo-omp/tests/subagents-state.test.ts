import { describe, expect, test } from "vitest";
import {
  INITIAL_SUBAGENT_PANEL_STATE,
  isSubagentRequestPending,
  type SubagentPanelAction,
  type SubagentPanelState,
  steerDraftProblem,
  subagentPanelReducer,
} from "../client/subagents-state";
import {
  cancelOmpSubagent,
  isLiveOmpSubagentStatus,
  listOmpSubagents,
  OMP_SUBAGENT_STEER_MAX_LENGTH,
  OmpSubagentStatusSchema,
  steerOmpSubagent,
} from "../shared/subagents";

function run(...actions: SubagentPanelAction[]): SubagentPanelState {
  return actions.reduce(subagentPanelReducer, INITIAL_SUBAGENT_PANEL_STATE);
}

describe("OMP subagent panel state", () => {
  test("cancel requires a confirmation and reports idempotent outcomes", () => {
    const confirming = run({ type: "request-cancel", subagentId: "child-1" });
    expect(confirming).toEqual({ kind: "confirming-cancel", subagentId: "child-1" });
    expect(subagentPanelReducer(confirming, { type: "dismiss" })).toEqual(
      INITIAL_SUBAGENT_PANEL_STATE,
    );
    const cancelling = subagentPanelReducer(confirming, { type: "submit" });
    expect(cancelling).toEqual({ kind: "cancelling", subagentId: "child-1" });
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
    const empty = run({ type: "start-steer", subagentId: "child-1" }, { type: "submit" });
    expect(empty).toEqual({
      kind: "steering",
      subagentId: "child-1",
      draft: "",
      error: "Enter a message for the subagent",
    });
    const sending = run(
      { type: "start-steer", subagentId: "child-1" },
      { type: "edit-draft", draft: "Focus on the parser" },
      { type: "submit" },
    );
    expect(sending).toEqual({
      kind: "sending",
      subagentId: "child-1",
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
      subagentId: "child-1",
      draft: "Focus on the parser",
      error: "This subagent is no longer running",
    });
  });

  test("ignores new requests and unrelated outcomes while a request is pending", () => {
    const sending = run(
      { type: "start-steer", subagentId: "child-1" },
      { type: "edit-draft", draft: "focus" },
      { type: "submit" },
    );
    for (const action of [
      { type: "request-cancel", subagentId: "child-2" },
      { type: "start-steer", subagentId: "child-2" },
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
