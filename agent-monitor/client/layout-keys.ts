import type { AgentSort, GroupingMode } from "../shared/monitor-settings";

export type GroupingChoice = { id: GroupingMode; key: string; label: string; hint: string };
export type SortChoice = { id: AgentSort; key: string; label: string; hint: string };

/**
 * Grouping and sort are separate axes: a host or type group still sorts its
 * rows (triage, recency, title). Keys avoid the view (R/G/O) and filter
 * (A/T/U/I/C) letters so nothing collides.
 */
export const GROUPING_CHOICES: readonly GroupingChoice[] = [
  { id: "project", key: "P", label: "Project", hint: "Project to workspace hierarchy" },
  { id: "workspace", key: "W", label: "Workspace", hint: "One group per workspace" },
  { id: "host", key: "H", label: "Host", hint: "One group per daemon" },
  { id: "provider", key: "Y", label: "Type", hint: "One group per agent provider" },
  { id: "compact", key: "N", label: "None", hint: "Flat list, no groups" },
];

export const SORT_CHOICES: readonly SortChoice[] = [
  { id: "triage", key: "S", label: "Triage", hint: "Attention first, then running and idle" },
  { id: "updated", key: "E", label: "Recent", hint: "Most recently used first" },
  { id: "title", key: "Z", label: "A-Z", hint: "Title A to Z" },
];

const GROUPING_BY_KEY = new Map(
  GROUPING_CHOICES.map((choice) => [choice.key.toLowerCase(), choice.id]),
);
const SORT_BY_KEY = new Map(SORT_CHOICES.map((choice) => [choice.key.toLowerCase(), choice.id]));

/** The layout patch a keypress asks for, or null when the key is not a layout key. */
export function layoutForKey(
  key: string,
): { grouping: GroupingMode } | { agentSort: AgentSort } | null {
  const lowered = key.toLowerCase();
  if (lowered.length !== 1) return null;
  const grouping = GROUPING_BY_KEY.get(lowered);
  if (grouping) return { grouping };
  const agentSort = SORT_BY_KEY.get(lowered);
  if (agentSort) return { agentSort };
  return null;
}
