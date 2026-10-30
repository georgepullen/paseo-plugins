import { describe, expect, test } from "vitest";
import { GROUPING_CHOICES, layoutForKey, SORT_CHOICES } from "../client/layout-keys";

describe("layout keys", () => {
  test("maps grouping keys case-insensitively", () => {
    expect(layoutForKey("p")).toEqual({ grouping: "project" });
    expect(layoutForKey("H")).toEqual({ grouping: "host" });
    expect(layoutForKey("y")).toEqual({ grouping: "provider" });
    expect(layoutForKey("n")).toEqual({ grouping: "compact" });
  });

  test("maps sort keys separately from grouping", () => {
    expect(layoutForKey("s")).toEqual({ agentSort: "triage" });
    expect(layoutForKey("e")).toEqual({ agentSort: "updated" });
    expect(layoutForKey("z")).toEqual({ agentSort: "title" });
  });

  test("ignores unrelated keys and multi-character keys", () => {
    expect(layoutForKey("r")).toBeNull();
    expect(layoutForKey("Enter")).toBeNull();
  });

  test("every choice key is unique across both axes", () => {
    const keys = [...GROUPING_CHOICES, ...SORT_CHOICES].map((choice) => choice.key.toLowerCase());
    expect(new Set(keys).size).toBe(keys.length);
  });
});
