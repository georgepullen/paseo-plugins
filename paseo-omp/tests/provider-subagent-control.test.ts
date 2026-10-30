import { describe, expect, test } from "vitest";
import type { OmpSubagentSnapshot } from "../server/provider/omp-rpc-protocol";
import { OmpRpcRequestRejectedError } from "../server/provider/omp-rpc-transport";
import { createOmpProvider } from "../server/provider/registration";
import {
  OmpSubagentControlRegistry,
  type OmpSubagentControls,
  resolveCancelOmpSubagent,
  resolveListOmpSubagents,
  resolveSteerOmpSubagent,
} from "../server/subagents";
import {
  EventLog,
  FakeOmpRuntime,
  ManualScheduler,
  MODEL_PUBLIC_ID,
  openSession,
  sessionAt,
  startPrompt,
  TEST_RUNTIME_ENV,
  turnIdFrom,
} from "./helpers/provider-harness";

function snapshot(id: string, status: OmpSubagentSnapshot["status"] = "running") {
  return { id, index: 0, agent: "worker", description: `${id} task`, status, lastUpdate: 1 };
}

async function onlyHandle(registry: OmpSubagentControlRegistry, agentId: string) {
  const [subagent] = (await resolveListOmpSubagents({ agentId }, registry)).subagents;
  if (!subagent) throw new Error("Missing listed subagent");
  return subagent.id;
}

async function createControlledHarness() {
  const runtime = new FakeOmpRuntime();
  const registry = new OmpSubagentControlRegistry();
  const connection = await createOmpProvider({
    runtime,
    timelineScheduler: new ManualScheduler(),
    environment: TEST_RUNTIME_ENV,
    subagentControlRegistry: registry,
  }).connect({
    versions: [1],
    capabilities: ["prompt.message", "prompt.steer", "session.subsession"],
  });
  const events = new EventLog();
  connection.onEvent((event) => events.push(event));
  return { connection, events, runtime, registry };
}

describe("OMP subagent controls", () => {
  test("route each agent only to its own session's running subagents", async () => {
    const { connection, events, runtime, registry } = await createControlledHarness();
    await openSession(
      connection,
      events,
      "open-a",
      "session-a",
      {
        PASEO_AGENT_ID: "agent-a",
        ACME_API_KEY: "credential-secret",
      },
      MODEL_PUBLIC_ID,
      "medium",
      false,
      {
        providerOptions: { outputRedaction: "configured-values" },
      },
    );
    await openSession(connection, events, "open-b", "session-b", { PASEO_AGENT_ID: "agent-b" });
    const first = sessionAt(runtime, 0);
    const second = sessionAt(runtime, 1);
    first.subagents = [
      { ...snapshot("a-credential-secret"), description: "uses credential-secret" },
      snapshot("a-finished", "completed"),
    ];
    second.subagents = [snapshot("b-child")];

    const listedA = (await resolveListOmpSubagents({ agentId: "agent-a" }, registry)).subagents;
    expect(listedA).toEqual([
      {
        id: expect.stringMatching(/^[A-Za-z0-9_-]{32}$/),
        name: "a-<redacted>",
        agent: "worker",
        description: "uses <redacted>",
        status: "running",
      },
      {
        id: expect.stringMatching(/^[A-Za-z0-9_-]{32}$/),
        name: "a-finished",
        agent: "worker",
        description: "a-finished task",
        status: "completed",
      },
    ]);
    expect(JSON.stringify(listedA)).not.toContain("credential-secret");
    const [running, finished] = listedA.map((subagent) => subagent.id);
    const [foreign] = (await resolveListOmpSubagents({ agentId: "agent-b" }, registry)).subagents;
    if (!running || !finished || !foreign) throw new Error("Missing listed subagents");

    await expect(
      resolveCancelOmpSubagent({ agentId: "agent-a", subagentId: foreign.id }, registry),
    ).resolves.toEqual({ cancelled: false });
    await expect(
      resolveSteerOmpSubagent(
        { agentId: "agent-a", subagentId: foreign.id, message: "x" },
        registry,
      ),
    ).rejects.toThrow("This subagent is no longer running");
    await expect(
      resolveCancelOmpSubagent({ agentId: "agent-a", subagentId: "a-credential-secret" }, registry),
    ).resolves.toEqual({ cancelled: false });
    await expect(
      resolveCancelOmpSubagent({ agentId: "agent-a", subagentId: finished }, registry),
    ).resolves.toEqual({ cancelled: false });
    expect(first.subagentCancels).toEqual([]);
    expect(second.subagentCancels).toEqual([]);
    expect(first.subagentSteers).toEqual([]);

    await expect(
      resolveSteerOmpSubagent(
        { agentId: "agent-a", subagentId: running, message: "Focus on the parser" },
        registry,
      ),
    ).resolves.toEqual({ accepted: true });
    await expect(
      resolveCancelOmpSubagent({ agentId: "agent-a", subagentId: running }, registry),
    ).resolves.toEqual({ cancelled: true });
    first.subagentCancelResult = false;
    await expect(
      resolveCancelOmpSubagent({ agentId: "agent-a", subagentId: running }, registry),
    ).resolves.toEqual({ cancelled: false });
    expect(first.subagentSteers).toEqual([
      { subagentId: "a-credential-secret", message: "Focus on the parser" },
    ]);
    expect(first.subagentCancels).toEqual(["a-credential-secret", "a-credential-secret"]);
    expect(second.subagentCancels).toEqual([]);

    await connection.send({ type: "session.close", requestId: "close-a", sessionId: "session-a" });
    await events.waitFor(
      (event) => event.type === "request.completed" && event.requestId === "close-a",
    );
    expect(registry.get("agent-a")).toBeUndefined();
    await expect(resolveListOmpSubagents({ agentId: "agent-a" }, registry)).resolves.toEqual({
      subagents: [],
    });
    await expect(
      resolveCancelOmpSubagent({ agentId: "agent-a", subagentId: running }, registry),
    ).rejects.toThrow("This agent has no running OMP Plugin session");
    expect(registry.get("agent-b")).toBeDefined();
    await connection.close();
    expect(registry.get("agent-b")).toBeUndefined();
  });

  test("cancels a child while the parent turn keeps running and completes later", async () => {
    const { connection, events, runtime, registry } = await createControlledHarness();
    await openSession(connection, events, "open-1", "session-1", { PASEO_AGENT_ID: "agent-1" });
    const session = sessionAt(runtime);
    const turnId = turnIdFrom(await startPrompt(connection, events));
    session.emit({ type: "prompt_result", id: "rpc-prompt-1", agentInvoked: true });
    session.emit({
      type: "tool_execution_start",
      toolCallId: "task-1",
      toolName: "task",
      args: { agent: "worker", task: "inspect" },
    });
    session.emit({
      type: "subagent_lifecycle",
      payload: {
        id: "child-1",
        agent: "worker",
        status: "started",
        parentToolCallId: "task-1",
        index: 0,
      },
    });
    const childOpened = await events.waitFor(
      (event) => event.type === "session.opened" && event.parentSessionId === "session-1",
    );
    if (childOpened.type !== "session.opened") throw new Error("Missing child session");
    session.subagents = [snapshot("child-1")];
    const handle = await onlyHandle(registry, "agent-1");

    await expect(
      resolveCancelOmpSubagent({ agentId: "agent-1", subagentId: handle }, registry),
    ).resolves.toEqual({ cancelled: true });
    session.subagents = [];
    session.emit({
      type: "subagent_lifecycle",
      payload: {
        id: "child-1",
        agent: "worker",
        status: "aborted",
        parentToolCallId: "task-1",
        index: 0,
      },
    });
    await events.waitFor(
      (event) =>
        event.type === "session.turn" &&
        event.sessionId === childOpened.sessionId &&
        event.state === "canceled",
    );
    expect(
      events.some(
        (event) =>
          event.type === "session.turn" && event.turnId === turnId && event.state !== "started",
      ),
    ).toBe(false);
    expect(session.aborts).toBe(0);

    session.emit({
      type: "tool_execution_end",
      toolCallId: "task-1",
      toolName: "task",
      result: { details: { results: [{ id: "child-1", aborted: true }] } },
      isError: true,
    });
    session.emit({ type: "agent_end", requestId: "rpc-prompt-1", messages: [], isTerminal: true });
    await expect(
      events.waitFor(
        (event) =>
          event.type === "session.turn" && event.turnId === turnId && event.state !== "started",
      ),
    ).resolves.toEqual(expect.objectContaining({ state: "completed" }));
    await connection.close();
  });

  test("never lists or controls a dead runtime and maps OMP failures to fixed messages", async () => {
    const { connection, events, runtime, registry } = await createControlledHarness();
    await openSession(connection, events, "open-1", "session-1", { PASEO_AGENT_ID: "agent-1" });
    const session = sessionAt(runtime);
    session.subagents = [snapshot("child-1")];
    const handle = await onlyHandle(registry, "agent-1");
    const cancel = () =>
      resolveCancelOmpSubagent({ agentId: "agent-1", subagentId: handle }, registry);
    const steer = () =>
      resolveSteerOmpSubagent(
        { agentId: "agent-1", subagentId: handle, message: "focus" },
        registry,
      );

    session.subagentControlError = new OmpRpcRequestRejectedError(undefined, "unsupported_command");
    await expect(cancel()).rejects.toThrow(
      "Update OMP to 18.4.9 or newer to control subagents from Paseo",
    );
    session.subagentControlError = new Error("OMP RPC request timed out");
    await expect(steer()).rejects.toThrow(
      "OMP did not confirm delivery in time. The subagent may still receive the message",
    );
    await expect(cancel()).rejects.toThrow(
      "OMP did not confirm the cancellation in time. Check the subagent before retrying",
    );
    session.subagentControlError = new Error("Subagent refused the message: private output");
    await expect(steer()).rejects.toThrow(
      "OMP did not accept the message. The subagent may have finished or refused it",
    );
    await expect(cancel()).rejects.toThrow("OMP could not cancel the subagent");
    session.subagentsError = new Error("native listing detail");
    await expect(resolveListOmpSubagents({ agentId: "agent-1" }, registry)).rejects.toThrow(
      "Could not list the OMP subagents",
    );
    session.subagentsError = null;

    const cancelsBeforeExit = session.subagentCancels.length;
    session.emit({ type: "process_exit", error: "OMP exited between turns" });
    await expect(resolveListOmpSubagents({ agentId: "agent-1" }, registry)).resolves.toEqual({
      subagents: [],
    });
    await expect(cancel()).resolves.toEqual({ cancelled: false });
    await expect(steer()).rejects.toThrow("This subagent is no longer running");
    expect(session.subagentCancels).toHaveLength(cancelsBeforeExit);
    expect(runtime.starts).toHaveLength(1);
    await connection.close();
  });

  test("sends nothing when the runtime dies while the roster is being read", async () => {
    const { connection, events, runtime, registry } = await createControlledHarness();
    await openSession(connection, events, "open-1", "session-1", { PASEO_AGENT_ID: "agent-1" });
    const session = sessionAt(runtime);
    session.subagents = [snapshot("child-1")];
    const handle = await onlyHandle(registry, "agent-1");
    const gate = Promise.withResolvers<void>();
    const bothReading = Promise.withResolvers<void>();
    let reads = 0;
    session.subagentsGate = gate.promise;
    session.subagentsObserved = () => {
      reads += 1;
      if (reads === 2) bothReading.resolve();
    };
    const cancelling = resolveCancelOmpSubagent(
      { agentId: "agent-1", subagentId: handle },
      registry,
    );
    const steering = resolveSteerOmpSubagent(
      { agentId: "agent-1", subagentId: handle, message: "focus" },
      registry,
    );
    await bothReading.promise;
    session.emit({ type: "process_exit", error: "OMP exited between turns" });
    gate.resolve();
    await expect(cancelling).resolves.toEqual({ cancelled: false });
    await expect(steering).rejects.toThrow("This subagent is no longer running");
    expect(session.subagentCancels).toEqual([]);
    expect(session.subagentSteers).toEqual([]);
    await connection.close();
  });

  test("lets a newer session replace an agent's controls without the older cleanup removing it", () => {
    const registry = new OmpSubagentControlRegistry();
    const controls = (): OmpSubagentControls => ({
      listSubagents: async () => [],
      cancelSubagent: async () => false,
      steerSubagent: async () => {},
    });
    const older = controls();
    const newer = controls();
    const removeOlder = registry.register("agent-1", older);
    const removeNewer = registry.register("agent-1", newer);
    removeOlder();
    expect(registry.get("agent-1")).toBe(newer);
    removeNewer();
    expect(registry.get("agent-1")).toBeUndefined();
  });
});
