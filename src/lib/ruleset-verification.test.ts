import { describe, expect, it } from "vitest";

// Throwaway #57 ruleset verification: fails on purpose so the required check blocks merging.
describe("#57 ruleset verification", () => {
  it("fails deliberately", () => {
    expect(1).toBe(2);
  });
});
