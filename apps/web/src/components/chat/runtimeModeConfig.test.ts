import { describe, expect, it } from "vite-plus/test";

import { runtimeModeConfigForProvider } from "./runtimeModeConfig";

describe("runtime mode presentation", () => {
  it("presents auto as Codex Review only for Claude", () => {
    expect(runtimeModeConfigForProvider("claudeAgent").auto.label).toBe("Codex Review");
    expect(runtimeModeConfigForProvider("codex").auto.label).toBe("Auto");
    expect(runtimeModeConfigForProvider(undefined).auto.label).toBe("Auto");
  });
});
