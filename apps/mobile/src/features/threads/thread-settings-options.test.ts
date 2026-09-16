import type { ProviderOptionDescriptor } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { runtimeModeChoicesForProvider, selectableChoices } from "./thread-settings-options";

const effortDescriptor: Extract<ProviderOptionDescriptor, { type: "select" }> = {
  id: "effort",
  label: "Reasoning",
  type: "select",
  options: [
    { id: "low", label: "Low" },
    { id: "medium", label: "Medium", isDefault: true },
    { id: "high", label: "High" },
    { id: "ultrathink", label: "Ultrathink" },
    { id: "ultracode", label: "Ultracode" },
  ],
  currentValue: "high",
  promptInjectedValues: ["ultrathink"],
};

describe("selectableChoices", () => {
  it("hides prompt-injected and workflow-trigger choices, keeping declared order", () => {
    expect(selectableChoices(effortDescriptor).map((choice) => choice.id)).toEqual([
      "low",
      "medium",
      "high",
    ]);
  });
});

describe("runtime mode choices", () => {
  it("presents auto as Codex Review only for Claude", () => {
    const claudeAuto = runtimeModeChoicesForProvider("claudeAgent").find(
      (choice) => choice.mode === "auto",
    );
    const codexAuto = runtimeModeChoicesForProvider("codex").find(
      (choice) => choice.mode === "auto",
    );

    expect(claudeAuto?.label).toBe("Codex Review");
    expect(codexAuto?.label).toBe("Auto");
  });
});
