import { describe, expect, it } from "vitest";

import { money, monthLabel, pct } from "@/lib/format";

describe("pct", () => {
  it.each([
    ["0.2955", "29.6%"], // a float would print 29.5%
    ["0.2018", "20.2%"],
    ["0.0005", "0.1%"],
    ["0.00049", "0.0%"],
    ["1", "100.0%"],
    ["1.5", "150.0%"],
    ["-0.1234", "-12.3%"],
    ["-0.0001", "0.0%"],
  ])("%s -> %s", (ratio, expected) => {
    expect(pct(ratio)).toBe(expected);
  });

  it.each([null, undefined, "", "abc", "1e-3"])("renders %s as a dash", (ratio) => {
    expect(pct(ratio as string | null | undefined)).toBe("—");
  });
});

describe("money", () => {
  it("uses the currency when it is a code, plain numbers otherwise", () => {
    expect(money("23013.75", "USD")).toBe("$23,013.75");
    expect(money("2744.66", "EUR")).toBe("€2,744.66");
    expect(money("12", null)).toBe("12.00");
    expect(money(null, "USD")).toBe("—");
  });
});

describe("monthLabel", () => {
  it("is timezone independent", () => {
    expect(monthLabel("2026-07")).toBe("Jul 2026");
    expect(monthLabel("2026-01")).toBe("Jan 2026");
  });
});
