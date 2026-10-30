import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const OMP_SUBAGENT_STEER_MAX_LENGTH = 16_384;
export const OMP_SUBAGENT_DESCRIPTION_MAX_LENGTH = 512;

const AgentIdSchema = z.string().min(1).max(256);
const SubagentIdSchema = z.string().min(1).max(256);

export const OmpSubagentStatusSchema = z.enum([
  "pending",
  "running",
  "started",
  "completed",
  "failed",
  "aborted",
]);
export type OmpSubagentStatus = z.infer<typeof OmpSubagentStatusSchema>;

export const OmpSubagentSchema = z.object({
  /** Opaque handle scoped to the agent's current OMP session, never the native OMP ID. */
  id: SubagentIdSchema,
  /** The native OMP ID for display, after the session's output redaction. */
  name: z.string().min(1).max(256),
  agent: z.string().min(1).max(256),
  description: z.string().max(OMP_SUBAGENT_DESCRIPTION_MAX_LENGTH).nullable(),
  status: OmpSubagentStatusSchema,
});
export type OmpSubagent = z.infer<typeof OmpSubagentSchema>;

export const listOmpSubagents = defineRpc({
  name: "paseo-omp.list-subagents",
  input: z.object({ agentId: AgentIdSchema }),
  output: z.object({ subagents: z.array(OmpSubagentSchema).max(1_024) }),
});

export const cancelOmpSubagent = defineRpc({
  name: "paseo-omp.cancel-subagent",
  input: z.object({ agentId: AgentIdSchema, subagentId: SubagentIdSchema }),
  /** `false` when the subagent had already finished; cancelling is idempotent. */
  output: z.object({ cancelled: z.boolean() }),
});

export const steerOmpSubagent = defineRpc({
  name: "paseo-omp.steer-subagent",
  input: z.object({
    agentId: AgentIdSchema,
    subagentId: SubagentIdSchema,
    message: z.string().trim().min(1).max(OMP_SUBAGENT_STEER_MAX_LENGTH),
  }),
  output: z.object({ accepted: z.literal(true) }),
});

/** OMP reaches a subagent only while its roster lists it as running or pending. */
export function isLiveOmpSubagentStatus(status: OmpSubagentStatus): boolean {
  return status === "pending" || status === "running";
}
