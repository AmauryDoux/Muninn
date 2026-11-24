import { describe, expect, it } from "vitest";
import { normalizeUsername, passwordProblem, passwordStrength } from "../worker/core/password";

describe("password policy", () => {
  it("accepts a password with all four classes", () => {
    expect(passwordProblem("zwasp", "Rav3n!sky")).toBeNull();
  });
  it("enforces length and each class", () => {
    expect(passwordProblem("zwasp", "Ab1!")).toMatch(/8 characters/);
    expect(passwordProblem("zwasp", "rav3n!sky")).toMatch(/uppercase/);
    expect(passwordProblem("zwasp", "RAV3N!SKY")).toMatch(/lowercase/);
    expect(passwordProblem("zwasp", "Raven!sky")).toMatch(/number/);
    expect(passwordProblem("zwasp", "Rav3nSky9")).toMatch(/symbol/);
  });
  it("blocks common passwords that pass the class rules", () => {
    expect(passwordProblem("zwasp", "Password1!")).toMatch(/common/);
    expect(passwordProblem("zwasp", "Azerty#2026")).toMatch(/common/);
    expect(passwordProblem("zwasp", "Welcome@99")).toMatch(/common/);
    expect(passwordProblem("zwasp", "Xk!9ab1234")).toMatch(/sequences/);
  });
  it("blocks the username inside the password", () => {
    expect(passwordProblem("zwasp", "My-Zwasp-77")).toMatch(/username/);
  });
  it("strength grows with length", () => {
    expect(passwordStrength("Rav3n!sky")).toBe(1);
    expect(passwordStrength("Rav3n!sky-moon")).toBe(2);
    expect(passwordStrength("Rav3n!sky-moon-tide")).toBe(3);
  });
  it("normalizes usernames", () => {
    expect(normalizeUsername("  Zwasp ")).toBe("zwasp");
    expect(normalizeUsername("a")).toBeNull();
    expect(normalizeUsername("bad name")).toBeNull();
    expect(normalizeUsername("me@example.com")).toBe("me@example.com");
  });
});
