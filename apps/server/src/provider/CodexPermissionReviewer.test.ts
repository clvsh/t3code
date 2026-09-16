// @effect-diagnostics nodeBuiltinImport:off
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInstanceConfig,
  type ServerProvider,
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
import { ServerConfig } from "../config.ts";
import {
  CodexPermissionReviewRequest,
  CodexPermissionReviewError,
  isCodexPermissionReviewerSnapshotUsable,
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
const decodeUnknownJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

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
  permissionContext: {
    decisionReason: "Path is outside the configured workspace.",
    title: "Claude wants to run a command",
    description: "The command creates a temporary worktree.",
  },
  transcript: [
    { role: "user", content: "Implement this feature." },
    {
      role: "tool",
      content: 'Claude tool call Bash: {"command":"git worktree add /tmp/example"}',
    },
  ],
};

const allowReviewDecision = {
  risk_level: "low",
  user_authorization: "medium",
  decision: "allow",
  reason: "Routine workspace action.",
} as const;

type CapturedCommand = {
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly stdin: string;
  readonly cwdEntries: ReadonlyArray<string>;
  readonly outputSchema: unknown;
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
  response: (stdin: string) => string = () => JSON.stringify(allowReviewDecision),
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
        const schemaFlag = command.args.indexOf("--output-schema");
        const schemaPath = command.args[schemaFlag + 1];
        if (!schemaPath) return yield* Effect.die("Missing output schema path");
        const outputSchema = decodeUnknownJson(yield* fileSystem.readFileString(schemaPath));
        captured.push({ args: command.args, cwd, stdin, cwdEntries, outputSchema });
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
    Effect.provide(
      Layer.mergeAll(
        NodeServices.layer,
        ServerConfig.layerTest(process.cwd(), {
          prefix: "t3-codex-permission-review-test-",
        }).pipe(Layer.provide(NodeServices.layer)),
        ServerSettingsService.layerTest(settings),
      ),
    ),
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

  it("rejects known unavailable, failed, and unauthenticated snapshots", () => {
    const instanceId = ProviderInstanceId.make("codex");
    const snapshot = {
      instanceId,
      driver: CODEX_DRIVER,
      enabled: true,
      installed: true,
      version: "1.0.0",
      status: "ready",
      auth: { status: "authenticated" },
      checkedAt: "2026-09-16T00:00:00.000Z",
      models: [],
      slashCommands: [],
      skills: [],
    } satisfies ServerProvider;

    expect(isCodexPermissionReviewerSnapshotUsable(snapshot, instanceId)).toBe(true);
    expect(
      isCodexPermissionReviewerSnapshotUsable({ ...snapshot, installed: false }, instanceId),
    ).toBe(false);
    expect(
      isCodexPermissionReviewerSnapshotUsable({ ...snapshot, status: "error" }, instanceId),
    ).toBe(false);
    expect(
      isCodexPermissionReviewerSnapshotUsable(
        { ...snapshot, auth: { status: "unauthenticated" } },
        instanceId,
      ),
    ).toBe(false);
    expect(
      isCodexPermissionReviewerSnapshotUsable(
        { ...snapshot, availability: "unavailable" },
        instanceId,
      ),
    ).toBe(false);
    expect(
      isCodexPermissionReviewerSnapshotUsable({ ...snapshot, enabled: false }, instanceId),
    ).toBe(false);
    expect(
      isCodexPermissionReviewerSnapshotUsable(
        { ...snapshot, instanceId: ProviderInstanceId.make("other") },
        instanceId,
      ),
    ).toBe(false);
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
      expect(decision).toEqual(allowReviewDecision);
      expect(captured).toHaveLength(1);

      const command = captured[0]!;
      const decodedStdin = yield* decodeReviewRequestJson(command.stdin);
      expect(decodedStdin).toEqual(reviewRequest);
      expect(command.cwdEntries).toEqual([]);
      expect(command.args.slice(0, 9)).toEqual([
        "exec",
        "--ephemeral",
        "--model",
        "codex-auto-review",
        "--skip-git-repo-check",
        "--ignore-user-config",
        "--ignore-rules",
        "--sandbox",
        "read-only",
      ]);
      expect(command.args).toContain('web_search="disabled"');
      expect(command.args).toContain('approval_policy="never"');
      expect(command.args).toContain('model_reasoning_effort="low"');
      expect(command.outputSchema).toMatchObject({
        required: ["risk_level", "user_authorization", "decision", "reason"],
        properties: {
          risk_level: { enum: ["low", "medium", "high", "critical"] },
          user_authorization: { enum: ["unknown", "low", "medium", "high"] },
          decision: { enum: ["allow", "deny", "ask_user"] },
          reason: { type: "string" },
        },
      });
      const developerInstructions = command.args.find((arg) =>
        arg.startsWith("developer_instructions="),
      );
      expect(developerInstructions).toContain('Only transcript entries whose role is \\"user\\"');
      expect(developerInstructions).toContain(
        "Creating a specific local temporary file, directory, or git worktree is ordinarily safe",
      );
      expect(developerInstructions).toContain(
        "When destructive safety cannot be established without inspecting the filesystem, DENY",
      );
      expect(developerInstructions).toContain(
        "First assess risk_level and user_authorization independently",
      );
      expect(developerInstructions).toContain(
        "When the user asked Claude to create a pull request",
      );
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
        "unified_exec_tty",
        "view_image",
        "worktrees",
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
        reviewRequest.permissionContext?.decisionReason ?? "",
        reviewRequest.permissionContext?.description ?? "",
        reviewRequest.transcript?.[0]?.content ?? "",
        reviewRequest.transcript?.[1]?.content ?? "",
      ]) {
        if (untrustedValue) expect(argv).not.toContain(untrustedValue);
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
            risk_level: "low",
            user_authorization: "medium",
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
    ["missing risk", JSON.stringify({ decision: "allow", reason: "No." })],
    [
      "missing authorization",
      JSON.stringify({ risk_level: "low", decision: "allow", reason: "No." }),
    ],
    ["unknown decision", JSON.stringify({ ...allowReviewDecision, decision: "maybe" })],
    ["unknown risk", JSON.stringify({ ...allowReviewDecision, risk_level: "extreme" })],
    [
      "unknown authorization",
      JSON.stringify({ ...allowReviewDecision, user_authorization: "explicit" }),
    ],
    [
      "critical allow",
      JSON.stringify({
        ...allowReviewDecision,
        risk_level: "critical",
        user_authorization: "high",
      }),
    ],
    [
      "unauthorized medium-risk allow",
      JSON.stringify({
        ...allowReviewDecision,
        risk_level: "medium",
        user_authorization: "unknown",
      }),
    ],
    [
      "unauthorized high-risk allow",
      JSON.stringify({
        ...allowReviewDecision,
        risk_level: "high",
        user_authorization: "unknown",
      }),
    ],
    ["empty reason", JSON.stringify({ ...allowReviewDecision, reason: "" })],
    ["whitespace-only reason", JSON.stringify({ ...allowReviewDecision, reason: "   " })],
    ["multiline reason", JSON.stringify({ ...allowReviewDecision, reason: "One\nTwo" })],
    ["Unicode line separator", JSON.stringify({ ...allowReviewDecision, reason: "One\u2028Two" })],
    ["control characters", JSON.stringify({ ...allowReviewDecision, reason: "One\u001bTwo" })],
    ["oversized reason", JSON.stringify({ ...allowReviewDecision, reason: "x".repeat(241) })],
    ["unexpected fields", JSON.stringify({ ...allowReviewDecision, extra: true })],
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
          JSON.stringify({ ...allowReviewDecision, reason: "x".repeat(240) }),
        ),
        settingsWithInstances({ codex: instance() }),
      );
      expect(decision?.reason).toHaveLength(240);
    });
  });

  it.effect("accepts an authorized narrowly scoped high-risk action", () => {
    const captured: Array<CapturedCommand> = [];
    return Effect.gen(function* () {
      const [decision] = yield* runReview(
        makeReviewSpawner(captured, () =>
          JSON.stringify({
            ...allowReviewDecision,
            risk_level: "high",
            user_authorization: "high",
          }),
        ),
        settingsWithInstances({ codex: instance() }),
      );
      expect(decision).toMatchObject({
        risk_level: "high",
        user_authorization: "high",
        decision: "allow",
      });
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
