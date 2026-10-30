import type { ProviderConnection, ProviderEvent } from "@getpaseo/plugin/server/provider";
import { describe, expect, test } from "vitest";
import {
  createHarness,
  type EventLog,
  establishTerminalOwnership,
  FakeOmpRuntime,
  finishTurn,
  openSession,
  sessionAt,
  startPrompt,
  turnIdFrom,
} from "./helpers/provider-harness";

const CAPABILITIES = ["prompt.message", "prompt.steer", "session.can_stop_runtime"];

async function within<T>(promise: Promise<T>, label: string): Promise<T> {
  const timeout = Promise.withResolvers<never>();
  const timer = setTimeout(
    () => timeout.reject(new Error(`Timed out waiting for ${label}`)),
    5_000,
  );
  try {
    return await Promise.race([promise, timeout.promise]);
  } finally {
    clearTimeout(timer);
  }
}

async function openIdle() {
  const harness = await createHarness(new FakeOmpRuntime(), undefined, CAPABILITIES);
  await openSession(harness.connection, harness.events);
  const session = sessionAt(harness.runtime);
  session.isSettled = true;
  session.hasPendingAsyncWork = false;
  return { ...harness, session };
}

function turnStarts(events: EventLog): string[] {
  return events.flatMap((event) =>
    event.type === "session.turn" && event.state === "started" ? [event.turnId] : [],
  );
}

function terminalOf(events: EventLog, turnId: string): Promise<ProviderEvent> {
  return within(
    events.waitFor(
      (event) =>
        event.type === "session.turn" && event.turnId === turnId && event.state !== "started",
    ),
    `the terminal state of turn ${turnId}`,
  );
}

async function canStop(
  connection: ProviderConnection,
  events: EventLog,
  requestId: string,
): Promise<boolean> {
  await connection.send({ type: "session.can_stop_runtime", requestId, sessionId: "session-1" });
  const answer = await events.waitFor(
    (event) => event.type === "session.can_stop_runtime" && event.requestId === requestId,
  );
  if (answer.type !== "session.can_stop_runtime") throw new Error("Expected a veto answer");
  return answer.canStop;
}

const reply = (content: string, stopReason = "stop") => ({
  role: "assistant" as const,
  content,
  stopReason,
});

describe("OMP runs started without a client prompt", () => {
  test("projects a self-started run as its own provider turn", async () => {
    const { connection, events, session } = await openIdle();
    session.emit({ type: "agent_start" });
    const [turnId] = turnStarts(events);
    if (!turnId) throw new Error("The self-started run opened no turn");
    session.emit({ type: "message_end", message: reply("resumed") });
    session.emit({ type: "agent_end", messages: [reply("resumed")], isTerminal: true });

    expect(await terminalOf(events, turnId)).toEqual(
      expect.objectContaining({ state: "completed" }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "timeline.item",
        item: expect.objectContaining({ type: "assistant_message", text: "resumed" }),
      }),
    );
    expect(events.filter((event) => event.type === "session.prompt_result")).toEqual([]);
    await connection.close();
  });

  test("keeps the previous outcome and opens a new turn when a run starts during its idle check", async () => {
    const { connection, events, session } = await openIdle();
    const first = turnIdFrom(await startPrompt(connection, events, "first", "work"));
    const state = Promise.withResolvers<void>();
    const checking = Promise.withResolvers<void>();
    session.stateGate = state.promise;
    session.stateObserved = checking.resolve;
    establishTerminalOwnership(session);
    session.emit({ type: "message_end", message: reply("first done") });
    session.emit({
      type: "agent_end",
      requestId: "rpc-prompt-1",
      messages: [reply("first done")],
      isTerminal: true,
    });
    await checking.promise;
    session.emit({ type: "agent_start" });
    session.emit({ type: "message_end", message: reply("second broke", "error") });
    session.emit({
      type: "agent_end",
      messages: [reply("second broke", "error")],
      isTerminal: true,
    });
    session.stateGate = null;
    state.resolve();

    expect(await terminalOf(events, first)).toEqual(
      expect.objectContaining({ state: "completed" }),
    );
    const second = await within(
      events.waitFor(
        (event) =>
          event.type === "session.turn" && event.state === "started" && event.turnId !== first,
      ),
      "the self-started run's turn",
    );
    if (second.type !== "session.turn") throw new Error("Expected a turn event");
    expect(await terminalOf(events, second.turnId)).toEqual(
      expect.objectContaining({ state: "failed", error: { message: "OMP assistant turn failed" } }),
    );
    await connection.close();
  });

  test("closes the previous turn when its idle check sees the next run already streaming", async () => {
    const { connection, events, session } = await openIdle();
    const first = turnIdFrom(await startPrompt(connection, events, "first", "work"));
    const state = Promise.withResolvers<void>();
    const checking = Promise.withResolvers<void>();
    session.stateGate = state.promise;
    session.stateObserved = checking.resolve;
    establishTerminalOwnership(session);
    session.emit({
      type: "agent_end",
      requestId: "rpc-prompt-1",
      messages: [reply("first done")],
      isTerminal: true,
    });
    await checking.promise;
    session.emit({ type: "agent_start" });
    session.emit({ type: "message_end", message: reply("second still working") });
    session.isStreaming = true;
    session.stateGate = null;
    state.resolve();

    expect(await terminalOf(events, first)).toEqual(
      expect.objectContaining({ state: "completed" }),
    );
    const second = await within(
      events.waitFor(
        (event) =>
          event.type === "session.turn" && event.state === "started" && event.turnId !== first,
      ),
      "the self-started run's turn",
    );
    if (second.type !== "session.turn") throw new Error("Expected a turn event");
    session.isStreaming = false;
    session.emit({
      type: "agent_end",
      messages: [reply("second broke", "error")],
      isTerminal: true,
    });
    expect(await terminalOf(events, second.turnId)).toEqual(
      expect.objectContaining({ state: "failed" }),
    );
    await connection.close();
  });

  test("fails the runtime when a run buffered behind a pending terminal exceeds its bound", async () => {
    const { connection, events, session } = await openIdle();
    const first = turnIdFrom(await startPrompt(connection, events, "first", "work"));
    const checking = Promise.withResolvers<void>();
    session.stateGate = new Promise(() => {});
    session.stateObserved = checking.resolve;
    establishTerminalOwnership(session);
    session.emit({
      type: "agent_end",
      requestId: "rpc-prompt-1",
      messages: [reply("first done")],
      isTerminal: true,
    });
    await checking.promise;
    session.emit({ type: "agent_start" });
    for (let index = 0; index < 512; index += 1) {
      session.emit({ type: "message_end", message: reply(`step ${index}`) });
    }

    expect(await terminalOf(events, first)).toEqual(
      expect.objectContaining({ state: "failed", error: { message: "OMP runtime failed" } }),
    );
    expect(session.closes).toBe(1);
    await connection.close();
  });

  test("restores a truncated held end's streamed outcome when OMP settles", async () => {
    const { connection, events, session } = await openIdle();
    const turnId = turnIdFrom(await startPrompt(connection, events, "held-truncated", "work"));
    session.canReplayHistory = false;
    establishTerminalOwnership(session);
    session.emit({ type: "message_end", message: reply("broke", "error") });
    session.emit({
      type: "agent_end",
      requestId: "rpc-prompt-1",
      messageCount: 1,
      messages: [],
      isTerminal: false,
    });
    session.emit({ type: "session_settled" });

    expect(await terminalOf(events, turnId)).toEqual(
      expect.objectContaining({ state: "failed", error: { message: "OMP assistant turn failed" } }),
    );
    await connection.close();
  });

  test("does not let evidence that arrives after a held end authorize it", async () => {
    const { connection, events, scheduler, session } = await openIdle();
    const first = turnIdFrom(await startPrompt(connection, events, "held-a", "first"));
    await finishTurn(events, session, first);
    session.promptAgentInvoked = undefined;
    const turnId = turnIdFrom(await startPrompt(connection, events, "held-b", "second"));
    // Unkeyed and ahead of any evidence for this prompt: not attributable to it.
    session.emit({ type: "agent_end", messages: [reply("old success")], isTerminal: false });
    session.branchMessages.push({ entryId: "held-user", text: "second" });
    session.emit({ type: "message_end", message: { role: "user", content: "second" } });
    await events.waitFor(
      (event) =>
        event.type === "timeline.item" &&
        event.item.type === "user_message" &&
        event.item.clientMessageId === "held-b",
    );
    session.emit({ type: "message_end", message: reply("current failure", "error") });
    session.emit({ type: "session_settled" });
    await scheduler.flush(2_000);
    // Let any terminal check the promotion started run to completion.
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(
      events.some(
        (event) =>
          event.type === "session.turn" && event.turnId === turnId && event.state === "completed",
      ),
    ).toBe(false);
    await connection.close();
  });

  test("finishes a held turn once OMP reports it settled without writing session_settled", async () => {
    const { connection, events, scheduler, session } = await openIdle();
    const turnId = turnIdFrom(await startPrompt(connection, events, "held", "work"));
    establishTerminalOwnership(session);
    session.emit({ type: "message_end", message: reply("waiting on a job") });
    session.emit({
      type: "agent_end",
      requestId: "rpc-prompt-1",
      messages: [reply("waiting on a job")],
      isTerminal: false,
    });
    session.hasPendingAsyncWork = true;
    await scheduler.flush(1_000);
    expect(events.some((event) => event.type === "session.turn" && event.state !== "started")).toBe(
      false,
    );

    // The job's delivery was cancelled: no run follows and OMP writes no session_settled.
    session.hasPendingAsyncWork = false;
    await scheduler.flush(1_000);

    expect(await terminalOf(events, turnId)).toEqual(
      expect.objectContaining({ state: "completed" }),
    );
    await connection.close();
  });

  test("keeps a held turn running on OMP builds that do not report settlement", async () => {
    const { connection, events, scheduler, session } = await openIdle();
    await startPrompt(connection, events, "held-legacy", "work");
    establishTerminalOwnership(session);
    session.isSettled = undefined;
    session.hasPendingAsyncWork = undefined;
    session.emit({
      type: "agent_end",
      requestId: "rpc-prompt-1",
      messages: [reply("waiting")],
      isTerminal: false,
    });
    await scheduler.flush(1_000);
    await scheduler.flush(1_000);

    expect(events.some((event) => event.type === "session.turn" && event.state !== "started")).toBe(
      false,
    );
    await connection.close();
  });

  test("vetoes idle release while a self-started run is in flight", async () => {
    const { connection, events, session } = await openIdle();
    expect(await canStop(connection, events, "before-run")).toBe(true);

    // The fake keeps answering settled, as a state lookup taken just before the run would.
    session.emit({ type: "agent_start" });
    expect(await canStop(connection, events, "during-run")).toBe(false);

    const [turnId] = turnStarts(events);
    if (!turnId) throw new Error("The self-started run opened no turn");
    session.emit({ type: "agent_end", messages: [reply("done")], isTerminal: true });
    await terminalOf(events, turnId);
    expect(await canStop(connection, events, "after-run")).toBe(true);
    await connection.close();
  });

  test("vetoes idle release when a run starts while the state lookup is pending", async () => {
    const { connection, events, session } = await openIdle();
    const state = Promise.withResolvers<void>();
    const lookup = Promise.withResolvers<void>();
    session.stateGate = state.promise;
    session.stateObserved = lookup.resolve;
    const answer = canStop(connection, events, "racing-run");
    await lookup.promise;
    session.emit({ type: "agent_start" });
    session.stateGate = null;
    state.resolve();

    expect(await answer).toBe(false);
    await connection.close();
  });
});
