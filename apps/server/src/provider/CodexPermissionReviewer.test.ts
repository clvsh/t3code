// @effect-diagnostics nodeBuiltinImport:off
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  type ProviderInstanceConfig,
  type ServerSettings,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as TestClock from "effect/testing/TestClock";

import { ServerSettingsService } from "../serverSettings.ts";
import {
  CodexPermissionReviewRequest,
  CodexPermissionReviewError,
  makeCodexPermissionReviewer,
  resolveCodexPermissionReviewerInstance,
} from "./CodexPermissionReviewer.ts";

const CODEX_DRIVER = ProviderDriverKind.make("codex");
const decodeReviewRequestJson = Schema.decodeEffect(
  Schema.fromJsonString(CodexPermissionReviewRequest),
);
const decodeReviewRequestJsonSync = Schema.decodeSync(
  Schema.fromJsonString(CodexPermissionReviewRequest),
);

function instance(
  config: unknown = {},
  options: Partial<Omit<ProviderInstanceConfig, "driver" | "config">> = {},
): ProviderInstanceConfig {
  return {
    driver: CODEX_DRIVER,
    config,
    ...options,
  };
}

function settingsWithInstances(
  providerInstances: Record<string, ProviderInstanceConfig>,
): ServerSettings {
  return {
    ...DEFAULT_SERVER_SETTINGS,
    providers: {
      ...DEFAULT_SERVER_SETTINGS.providers,
      codex: {
        ...DEFAULT_SERVER_SETTINGS.providers.codex,
        enabled: false,
      },
    },
    providerInstances: providerInstances as ServerSettings["providerInstances"],
  };
}

const reviewRequest: CodexPermissionReviewRequest = {
  toolName: "Bash",
  toolInput: {
    command: "vp test run nested.test.ts",
    nested: { values: ["one", { keep: true }] },
  },
  workspacePath: "/workspaces/example",
  requestType: "command_execution_approval",
  summary: "Run a focused test",
};

type CapturedCommand = {
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly stdin: string;
  readonly cwdEntries: ReadonlyArray<string>;
};

function makeHandle(
  exitCode: Effect.Effect<ChildProcessSpawner.ExitCode> = Effect.succeed(
    ChildProcessSpawner.ExitCode(0),
  ),
  onKill?: () => void,
) {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode,
    isRunning: Effect.succeed(true),
    kill: () => Effect.sync(() => onKill?.()),
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.empty,
    stderr: Stream.empty,
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

function makeReviewSpawner(
  captured: Array<CapturedCommand>,
  response: (stdin: string) => string = () =>
    JSON.stringify({ decision: "allow", reason: "Routine workspace action." }),
  exitCode: number | "never" = 0,
  onKill?: () => void,
  spawned?: Deferred.Deferred<void>,
) {
  return (fileSystem: FileSystem.FileSystem) =>
    ChildProcessSpawner.make((command) =>
      Effect.gen(function* () {
        if (command._tag !== "StandardCommand") return yield* Effect.die("Expected command");
        const cwd = command.options.cwd;
        const stdinSource = command.options.stdin;
        if (
          typeof cwd !== "string" ||
          !stdinSource ||
          typeof stdinSource !== "object" ||
          !("stream" in stdinSource) ||
          !Stream.isStream(stdinSource.stream)
        ) {
          return yield* Effect.die("Expected cwd and streamed stdin");
        }
        const stdin = yield* stdinSource.stream.pipe(
          Stream.decodeText(),
          Stream.runFold(
            () => "",
            (text, chunk) => text + chunk,
          ),
        );
        const cwdEntries = yield* fileSystem.readDirectory(cwd);
        captured.push({ args: command.args, cwd, stdin, cwdEntries });
        if (spawned) yield* Deferred.succeed(spawned, undefined);
        const outputFlag = command.args.indexOf("--output-last-message");
        const outputPath = command.args[outputFlag + 1];
        if (!outputPath) return yield* Effect.die("Missing output path");
        yield* fileSystem.writeFileString(outputPath, response(stdin));
        return makeHandle(
          exitCode === "never"
            ? Effect.never
            : Effect.succeed(ChildProcessSpawner.ExitCode(exitCode)),
          onKill,
        );
      }),
    );
}

function runReview(
  makeSpawner: (
    fileSystem: FileSystem.FileSystem,
  ) => ChildProcessSpawner.ChildProcessSpawner["Service"],
  settings: ServerSettings,
  requests: ReadonlyArray<CodexPermissionReviewRequest> = [reviewRequest],
) {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const reviewer = yield* makeCodexPermissionReviewer({
      spawner: makeSpawner(fileSystem),
    });
    return yield* Effect.forEach(
      requests,
      (request, index) => reviewer({ request, requestId: `request-${index}` }),
      { concurrency: "unbounded" },
    );
  }).pipe(
    Effect.provide(Layer.merge(NodeServices.layer, ServerSettingsService.layerTest(settings))),
  );
}

describe("Codex permission reviewer instance resolution", () => {
  it("uses the enabled legacy canonical instance", () => {
    const settings: ServerSettings = {
      ...DEFAULT_SERVER_SETTINGS,
      providers: {
        ...DEFAULT_SERVER_SETTINGS.providers,
        codex: {
          ...DEFAULT_SERVER_SETTINGS.providers.codex,
          binaryPath: "legacy-codex",
          enabled: true,
        },
      },
      providerInstances: {
        work: instance({ binaryPath: "custom-codex" }),
      } as ServerSettings["providerInstances"],
    };

    expect(resolveCodexPermissionReviewerInstance(settings)?.config.binaryPath).toBe(
      "legacy-codex",
    );
  });

  it("prefers the enabled canonical instance", () => {
    const resolved = resolveCodexPermissionReviewerInstance(
      settingsWithInstances({
        codex: instance({ binaryPath: "canonical-codex" }),
        work: instance({ binaryPath: "custom-codex" }),
      }),
    );

    expect(resolved?.config.binaryPath).toBe("canonical-codex");
  });

  it("uses the sole enabled custom instance when canonical is disabled", () => {
    const resolved = resolveCodexPermissionReviewerInstance(
      settingsWithInstances({
        codex: instance({}, { enabled: false }),
        work: instance(
          { binaryPath: "custom-codex" },
          { environment: [{ name: "CODEX_ACCOUNT", value: "work", sensitive: false }] },
        ),
      }),
    );

    expect(resolved?.config.binaryPath).toBe("custom-codex");
    expect(resolved?.environment.CODEX_ACCOUNT).toBe("work");
  });

  it("rejects missing, disabled, ambiguous, and invalid instances", () => {
    expect(resolveCodexPermissionReviewerInstance(settingsWithInstances({}))).toBeUndefined();
    expect(
      resolveCodexPermissionReviewerInstance(
        settingsWithInstances({ codex: instance({}, { enabled: false }) }),
      ),
    ).toBeUndefined();
    expect(
      resolveCodexPermissionReviewerInstance(
        settingsWithInstances({ one: instance(), two: instance() }),
      ),
    ).toBeUndefined();
    expect(
      resolveCodexPermissionReviewerInstance(
        settingsWithInstances({ one: instance({ binaryPath: 123 }) }),
      ),
    ).toBeUndefined();
  });
});

describe("Codex permission reviewer process", () => {
  it.effect("uses a restricted ephemeral process and preserves only the request fields", () => {
    const captured: Array<CapturedCommand> = [];
    return Effect.gen(function* () {
      const [decision] = yield* runReview(
        makeReviewSpawner(captured),
        settingsWithInstances({ codex: instance({ binaryPath: "codex-review" }) }),
      );
      expect(decision).toEqual({ decision: "allow", reason: "Routine workspace action." });
      expect(captured).toHaveLength(1);

      const command = captured[0]!;
      const decodedStdin = yield* decodeReviewRequestJson(command.stdin);
      expect(decodedStdin).toEqual(reviewRequest);
      expect(command.cwdEntries).toEqual([]);
      expect(command.args.slice(0, 7)).toEqual([
        "exec",
        "--ephemeral",
        "--skip-git-repo-check",
        "--ignore-user-config",
        "--ignore-rules",
        "--sandbox",
        "read-only",
      ]);
      expect(command.args).toContain('web_search="disabled"');
      expect(command.args).toContain('approval_policy="never"');
      expect(command.args.at(-1)).toBe("-");
      const expectedDisabledFeatures = [
        "apps",
        "artifact",
        "auth_elicitation",
        "browser_use",
        "browser_use_external",
        "browser_use_full_cdp_access",
        "code_mode",
        "code_mode_host",
        "computer_use",
        "default_mode_request_user_input",
        "goals",
        "hooks",
        "image_generation",
        "in_app_browser",
        "multi_agent",
        "multi_agent_v2",
        "plugins",
        "recommended_plugins",
        "remote_plugin",
        "request_permissions_tool",
        "shell_snapshot",
        "shell_tool",
        "skill_mcp_dependency_install",
        "skill_search",
        "sleep_tool",
        "tool_call_mcp_elicitation",
        "tool_suggest",
        "unified_exec",
        "view_image",
        "workspace_dependencies",
      ];
      expect(command.args.filter((arg) => arg === "--disable")).toHaveLength(
        expectedDisabledFeatures.length,
      );
      for (const feature of expectedDisabledFeatures) {
        expect(command.args).toContain(feature);
      }
      const argv = command.args.join(" ");
      for (const untrustedValue of [
        reviewRequest.toolName,
        reviewRequest.workspacePath,
        reviewRequest.requestType,
        reviewRequest.summary,
        (reviewRequest.toolInput as { command: string }).command,
      ]) {
        expect(argv).not.toContain(untrustedValue);
      }

      const fileSystem = yield* FileSystem.FileSystem;
      expect(yield* fileSystem.exists(command.cwd)).toBe(false);
    }).pipe(Effect.provide(NodeServices.layer));
  });

  it.effect("isolates concurrent reviews in separate directories and processes", () => {
    const captured: Array<CapturedCommand> = [];
    const secondRequest = {
      ...reviewRequest,
      toolInput: { command: "vp lint second.ts" },
    };
    return Effect.gen(function* () {
      const results = yield* runReview(
        makeReviewSpawner(captured, (stdin) => {
          const request = decodeReviewRequestJsonSync(stdin);
          return JSON.stringify({
            decision: "allow",
            reason: request.summary === reviewRequest.summary ? "First review." : "Second review.",
          });
        }),
        settingsWithInstances({ codex: instance() }),
        [reviewRequest, { ...secondRequest, summary: "Second request" }],
      );

      expect(results.map((result) => result.reason).sort()).toEqual([
        "First review.",
        "Second review.",
      ]);
      expect(captured).toHaveLength(2);
      expect(new Set(captured.map((command) => command.cwd)).size).toBe(2);
      expect(new Set(captured.map((command) => command.stdin)).size).toBe(2);
    });
  });

  for (const [name, output] of [
    ["malformed JSON", "not-json"],
    ["unknown decision", JSON.stringify({ decision: "maybe", reason: "No." })],
    ["empty reason", JSON.stringify({ decision: "allow", reason: "" })],
    ["whitespace-only reason", JSON.stringify({ decision: "allow", reason: "   " })],
    ["multiline reason", JSON.stringify({ decision: "allow", reason: "One\nTwo" })],
    ["Unicode line separator", JSON.stringify({ decision: "allow", reason: "One\u2028Two" })],
    ["control characters", JSON.stringify({ decision: "allow", reason: "One\u001bTwo" })],
    ["oversized reason", JSON.stringify({ decision: "allow", reason: "x".repeat(241) })],
    ["unexpected fields", JSON.stringify({ decision: "allow", reason: "Fine.", extra: true })],
  ] as const) {
    it.effect(`rejects ${name}`, () => {
      const captured: Array<CapturedCommand> = [];
      return Effect.gen(function* () {
        const error = yield* runReview(
          makeReviewSpawner(captured, () => output),
          settingsWithInstances({ codex: instance() }),
        ).pipe(Effect.flip);
        expect(error).toEqual(new CodexPermissionReviewError({ kind: "invalid" }));
      });
    });
  }

  it.effect("accepts a reason at the exact size limit", () => {
    const captured: Array<CapturedCommand> = [];
    return Effect.gen(function* () {
      const [decision] = yield* runReview(
        makeReviewSpawner(captured, () =>
          JSON.stringify({ decision: "allow", reason: "x".repeat(240) }),
        ),
        settingsWithInstances({ codex: instance() }),
      );
      expect(decision?.reason).toHaveLength(240);
    });
  });

  it.effect("fails closed on a nonzero exit", () => {
    const captured: Array<CapturedCommand> = [];
    return Effect.gen(function* () {
      const error = yield* runReview(
        makeReviewSpawner(captured, undefined, 1),
        settingsWithInstances({ codex: instance() }),
      ).pipe(Effect.flip);
      expect(error).toEqual(new CodexPermissionReviewError({ kind: "failed" }));
    });
  });

  it.effect("rejects an oversized reviewer output file", () => {
    const captured: Array<CapturedCommand> = [];
    return Effect.gen(function* () {
      const error = yield* runReview(
        makeReviewSpawner(captured, () => "x".repeat(4_097)),
        settingsWithInstances({ codex: instance() }),
      ).pipe(Effect.flip);
      expect(error).toEqual(new CodexPermissionReviewError({ kind: "invalid" }));
    });
  });

  it.effect("fails closed when the reviewer process cannot spawn", () => {
    const cause = PlatformError.systemError({
      _tag: "NotFound",
      module: "ChildProcess",
      method: "spawn",
      cause: new Error("missing reviewer binary"),
    });
    return Effect.gen(function* () {
      const error = yield* runReview(
        () => ChildProcessSpawner.make(() => Effect.fail(cause)),
        settingsWithInstances({ codex: instance() }),
      ).pipe(Effect.flip);
      expect(error).toEqual(new CodexPermissionReviewError({ kind: "failed" }));
    });
  });

  it.effect("times out and terminates the reviewer process", () => {
    const captured: Array<CapturedCommand> = [];
    let killCount = 0;
    return Effect.gen(function* () {
      const spawned = yield* Deferred.make<void>();
      const reviewFiber = yield* runReview(
        makeReviewSpawner(
          captured,
          undefined,
          "never",
          () => {
            killCount += 1;
          },
          spawned,
        ),
        settingsWithInstances({ codex: instance() }),
      ).pipe(Effect.forkChild);
      yield* Deferred.await(spawned);
      yield* Effect.yieldNow;
      yield* TestClock.adjust("30 seconds");
      const error = yield* Fiber.join(reviewFiber).pipe(Effect.flip);

      expect(error).toEqual(new CodexPermissionReviewError({ kind: "timeout" }));
      expect(captured).toHaveLength(1);
      expect(killCount).toBe(1);
    });
  });

  it.effect("terminates the reviewer process when the review is cancelled", () => {
    const captured: Array<CapturedCommand> = [];
    let killCount = 0;
    return Effect.gen(function* () {
      const spawned = yield* Deferred.make<void>();
      const reviewFiber = yield* runReview(
        makeReviewSpawner(
          captured,
          undefined,
          "never",
          () => {
            killCount += 1;
          },
          spawned,
        ),
        settingsWithInstances({ codex: instance() }),
      ).pipe(Effect.forkChild);
      yield* Deferred.await(spawned);
      yield* Effect.yieldNow;
      expect(captured).toHaveLength(1);
      yield* Fiber.interrupt(reviewFiber);

      expect(killCount).toBe(1);
    });
  });
});
