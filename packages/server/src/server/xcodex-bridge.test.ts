import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer, type Socket } from "node:net";
import { afterEach, test, expect } from "vitest";
import pino from "pino";
import { createXcodexBridgeClient } from "./xcodex-bridge.js";
import {
  AgentSnapshotPayloadSchema,
  FetchAgentTimelineResponseMessageSchema,
  WorkspaceDescriptorPayloadSchema,
} from "./messages.js";

const tempDirs: string[] = [];

interface HostBridgeTestRequest {
  kind?: string;
  id?: string;
  [key: string]: unknown;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function createLogger() {
  return pino({ enabled: false });
}

function findMessageSendRequest(requests: unknown[], messageId: string) {
  return requests.find(
    (request) =>
      typeof request === "object" &&
      request !== null &&
      (request as { kind?: unknown }).kind === "message.send" &&
      (request as { payload?: { messageId?: unknown } }).payload?.messageId === messageId,
  ) as { payload: { inputItems: Array<Record<string, unknown>> } } | undefined;
}

async function expectRichMobileMessageRequest(requests: unknown[]) {
  const richMessageRequest = findMessageSendRequest(requests, "message-2");
  expect(richMessageRequest?.payload.inputItems).toEqual([
    { type: "text", text: "from mobile with image", text_elements: [] },
    expect.objectContaining({ type: "localImage", path: expect.any(String) }),
    { type: "text", text: "extra context", text_elements: [] },
  ]);
  const imagePath = richMessageRequest?.payload.inputItems[1]?.path;
  expect(typeof imagePath).toBe("string");
  await expect(readFile(imagePath as string)).resolves.toEqual(Buffer.from("image-bytes"));
}

function writeDelayedThreadCreateResponse(socket: Socket, request: HostBridgeTestRequest) {
  setTimeout(() => {
    socket.end(
      JSON.stringify({
        kind: "response",
        id: request.id,
        ok: true,
        data: {
          accepted: true,
          threadId: "thread-delayed",
          turnId: "turn-delayed",
          agent: {
            id: "xcodex:workspace-1:thread-delayed",
            workspaceId: "workspace-1",
            workspaceName: "xCodex",
            cwd: "D:\\Dev\\self\\x-codex-worktree",
            threadId: "thread-delayed",
            title: "Delayed thread",
            preview: "hello",
            modelProvider: "provider-1",
            providerId: "provider-1",
            supplierId: "supplier-1",
            modelId: "model-1",
            createdAtMs: 1_700_000_000_000,
            updatedAtMs: 1_700_000_001_000,
            archivedAtMs: null,
            state: "active",
          },
        },
      }) + "\n",
    );
  }, 75);
}

test("projects xCodex host bridge agents and timeline into Paseo payloads", async () => {
  const requests: unknown[] = [];
  const server = createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const request = JSON.parse(buffer.slice(0, newline)) as HostBridgeTestRequest;
      requests.push(request);
      if (request.kind === "getAgent") {
        socket.end(
          JSON.stringify({
            ok: true,
            data: {
              agent: {
                id: request.agentId,
                workspaceId: "workspace-1",
                workspaceName: "xCodex",
                cwd: "D:\\Dev\\self\\x-codex-worktree",
                threadId: "thread-1",
                title: "Thread 1",
                preview: "Preview",
                modelProvider: "deepseek",
                createdAtMs: 1_700_000_000_000,
                updatedAtMs: 1_700_000_001_000,
                archivedAtMs: null,
                state: "active",
              },
            },
          }) + "\n",
        );
        return;
      }
      if (request.kind === "listAgents") {
        socket.end(
          JSON.stringify({
            ok: true,
            data: {
              agents: [
                {
                  id: "xcodex:workspace-1:thread-1",
                  workspaceId: "workspace-1",
                  workspaceName: "xCodex",
                  cwd: "D:\\Dev\\self\\x-codex-worktree",
                  threadId: "thread-1",
                  title: "Thread 1",
                  preview: "Preview",
                  modelProvider: "deepseek",
                  createdAtMs: 1_700_000_000_000,
                  updatedAtMs: 1_700_000_002_000,
                  archivedAtMs: null,
                  state: "active",
                },
                {
                  id: "xcodex:workspace-1:thread-2",
                  workspaceId: "workspace-1",
                  workspaceName: "xCodex",
                  cwd: "D:\\Dev\\self\\x-codex-worktree",
                  threadId: "thread-2",
                  title: "Thread 2",
                  preview: "Preview",
                  modelProvider: "gpt",
                  createdAtMs: 1_700_000_000_000,
                  updatedAtMs: 1_700_000_003_000,
                  archivedAtMs: null,
                  state: "active",
                },
              ],
            },
          }) + "\n",
        );
        return;
      }
      if (request.kind === "fetchTimeline") {
        socket.end(
          JSON.stringify({
            ok: true,
            data: {
              timeline: {
                agentId: request.agentId,
                epoch: request.agentId,
                minSeq: 1,
                maxSeq: 3,
                nextSeq: 4,
                entries: [
                  {
                    seq: 1,
                    timestamp: "2026-05-15T00:00:00.000Z",
                    kind: "user_message",
                    text: "hello",
                  },
                  {
                    seq: 2,
                    timestamp: "2026-05-15T00:00:01.000Z",
                    kind: "tool_call",
                    text: "",
                    callId: "call-1",
                    name: "shell_command",
                    status: "running",
                    detail: { input: { command: "git status" } },
                  },
                  {
                    seq: 3,
                    timestamp: "2026-05-15T00:00:02.000Z",
                    kind: "tool_call",
                    text: "clean",
                    callId: "call-1",
                    name: "shell_command",
                    status: "completed",
                    detail: { output: "clean" },
                  },
                ],
              },
            },
          }) + "\n",
        );
        return;
      }
      if (request.kind === "message.send") {
        socket.end(
          JSON.stringify({
            kind: "response",
            id: request.id,
            ok: true,
            data: {
              accepted: true,
              turnId: "turn-1",
            },
          }) + "\n",
        );
        return;
      }
      if (request.kind === "turn.interrupt") {
        socket.end(
          JSON.stringify({
            kind: "response",
            id: request.id,
            ok: true,
            data: {
              accepted: true,
              turnId: "turn-1",
            },
          }) + "\n",
        );
        return;
      }
      if (request.kind === "file.explorer") {
        socket.end(
          JSON.stringify({
            kind: "response",
            id: request.id,
            ok: true,
            data: {
              cwd: request.payload.cwd,
              path: "src",
              mode: "list",
              directory: {
                path: "src",
                entries: [
                  {
                    name: "index.ts",
                    path: "src/index.ts",
                    kind: "file",
                    size: 12,
                    modifiedAt: "2026-05-16T00:00:00.000Z",
                  },
                ],
              },
              file: null,
            },
          }) + "\n",
        );
        return;
      }
      if (request.kind === "project.icon") {
        socket.end(
          JSON.stringify({
            kind: "response",
            id: request.id,
            ok: true,
            data: {
              cwd: request.payload.cwd,
              icon: {
                data: "aWNvbg==",
                mimeType: "image/png",
              },
            },
          }) + "\n",
        );
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing test server address");
    const dir = await mkdtemp(path.join(tmpdir(), "xcodex-bridge-test-"));
    tempDirs.push(dir);
    const infoFile = path.join(dir, "xcodex-host-bridge.json");
    await writeFile(
      infoFile,
      JSON.stringify({ protocolVersion: 1, port: address.port, token: "secret" }),
      "utf8",
    );

    const bridge = createXcodexBridgeClient({ logger: createLogger(), infoFile });
    const agent = await bridge.getAgentPayloadById("xcodex:workspace-1:thread-1");
    expect(AgentSnapshotPayloadSchema.parse(agent).status).toBe("closed");
    expect(agent).toMatchObject({
      provider: "xcodex",
      persistence: {
        provider: "xcodex",
      },
      runtimeInfo: {
        provider: "xcodex",
      },
    });

    const timeline = await bridge.fetchTimeline({
      agentId: "xcodex:workspace-1:thread-1",
      direction: "after",
      projection: "projected",
      cursor: 1,
      limit: 50,
    });
    expect(timeline?.entries).toHaveLength(2);
    expect(timeline?.entries.every((entry) => entry.provider === "xcodex")).toBe(true);
    const response = FetchAgentTimelineResponseMessageSchema.parse({
      type: "fetch_agent_timeline_response",
      payload: {
        requestId: "request-1",
        agentId: "xcodex:workspace-1:thread-1",
        agent: timeline?.agent ?? null,
        direction: "after",
        projection: "projected",
        epoch: timeline?.epoch ?? "",
        reset: false,
        staleCursor: false,
        gap: false,
        window: timeline?.window ?? { minSeq: 0, maxSeq: 0, nextSeq: 0 },
        startCursor: { epoch: timeline?.epoch ?? "", seq: 1 },
        endCursor: { epoch: timeline?.epoch ?? "", seq: 3 },
        hasOlder: false,
        hasNewer: false,
        entries: timeline?.entries ?? [],
        error: null,
      },
    });
    const tool = response.payload.entries.find((entry) => entry.item.type === "tool_call");
    expect(tool?.item).toMatchObject({
      type: "tool_call",
      callId: "call-1",
      status: "completed",
      detail: { type: "unknown", output: "clean" },
    });
    expect(requests).toContainEqual(
      expect.objectContaining({
        kind: "fetchTimeline",
        agentId: "xcodex:workspace-1:thread-1",
        direction: "after",
        cursor: 1,
      }),
    );

    const workspaces = await bridge.listWorkspacePayloads({
      type: "fetch_workspaces_request",
      requestId: "workspaces-1",
      page: { limit: 20 },
    });
    expect(workspaces.entries).toHaveLength(1);
    expect(WorkspaceDescriptorPayloadSchema.parse(workspaces.entries[0])).toMatchObject({
      id: "workspace-1",
      projectId: "xcodex:workspace-1",
      projectKind: "non_git",
      workspaceKind: "directory",
      gitRuntime: null,
      githubRuntime: null,
      project: {
        projectKey: "xcodex:workspace-1",
      },
    });

    await expect(
      bridge.sendMessage({
        agentId: "xcodex:workspace-1:thread-1",
        text: "from mobile",
        messageId: "message-1",
      }),
    ).resolves.toMatchObject({ accepted: true, turnId: "turn-1" });
    await expect(
      bridge.sendMessage({
        agentId: "xcodex:workspace-1:thread-1",
        text: "from mobile with image",
        messageId: "message-2",
        images: [{ data: "aW1hZ2UtYnl0ZXM=", mimeType: "image/png" }],
        attachments: [
          {
            type: "text",
            mimeType: "text/plain",
            title: "Context",
            text: "extra context",
          },
        ],
      }),
    ).resolves.toMatchObject({ accepted: true, turnId: "turn-1" });
    await expect(bridge.cancelAgent("xcodex:workspace-1:thread-1")).resolves.toMatchObject({
      accepted: true,
      turnId: "turn-1",
    });
    await expect(
      bridge.fileExplorer({
        cwd: "D:\\Dev\\self\\x-codex-worktree",
        path: "src",
        mode: "list",
      }),
    ).resolves.toMatchObject({
      cwd: "D:\\Dev\\self\\x-codex-worktree",
      path: "src",
      mode: "list",
      directory: {
        entries: [{ name: "index.ts", path: "src/index.ts", kind: "file" }],
      },
      file: null,
    });
    await expect(bridge.projectIcon("D:\\Dev\\self\\x-codex-worktree")).resolves.toMatchObject({
      cwd: "D:\\Dev\\self\\x-codex-worktree",
      icon: {
        data: "aWNvbg==",
        mimeType: "image/png",
      },
    });
    expect(requests).toContainEqual(
      expect.objectContaining({
        kind: "message.send",
        payload: expect.objectContaining({
          agentId: "xcodex:workspace-1:thread-1",
          text: "from mobile",
          messageId: "message-1",
        }),
      }),
    );
    await expectRichMobileMessageRequest(requests);
    expect(requests).toContainEqual(
      expect.objectContaining({
        kind: "turn.interrupt",
        payload: { agentId: "xcodex:workspace-1:thread-1" },
      }),
    );
    expect(requests).toContainEqual(
      expect.objectContaining({
        kind: "file.explorer",
        payload: {
          cwd: "D:\\Dev\\self\\x-codex-worktree",
          path: "src",
          mode: "list",
        },
      }),
    );
    expect(requests).toContainEqual(
      expect.objectContaining({
        kind: "project.icon",
        payload: {
          cwd: "D:\\Dev\\self\\x-codex-worktree",
        },
      }),
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("uses the create-agent timeout budget for UI-mediated xCodex thread creation", async () => {
  const requests: unknown[] = [];
  const server = createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const request = JSON.parse(buffer.slice(0, newline));
      requests.push(request);
      if (request.kind === "runtime.catalog") {
        socket.end(
          JSON.stringify({
            kind: "response",
            id: request.id,
            ok: true,
            data: {
              generatedAtMs: 1_700_000_000_000,
              providers: [
                {
                  id: "provider-1",
                  label: "Provider 1",
                  defaultSupplierId: "supplier-1",
                  supportsSupplierSwitching: true,
                },
              ],
              suppliers: [
                {
                  id: "supplier-1",
                  label: "Supplier 1",
                  wireApi: "openai",
                },
              ],
              route: null,
              models: [
                {
                  id: "model-1",
                  label: "Model 1",
                  providerId: "provider-1",
                  supplierId: "supplier-1",
                },
              ],
            },
          }) + "\n",
        );
        return;
      }
      if (request.kind === "thread.create") {
        writeDelayedThreadCreateResponse(socket, request);
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing test server address");
    const dir = await mkdtemp(path.join(tmpdir(), "xcodex-bridge-test-"));
    tempDirs.push(dir);
    const infoFile = path.join(dir, "xcodex-host-bridge.json");
    await writeFile(
      infoFile,
      JSON.stringify({ protocolVersion: 2, port: address.port, token: "secret" }),
      "utf8",
    );

    const bridge = createXcodexBridgeClient({
      logger: createLogger(),
      infoFile,
      timeouts: {
        v2DefaultRequestMs: 25,
        v2ThreadCreateRequestMs: 250,
      },
    });

    await expect(
      bridge.createAgent({
        workspaceId: "workspace-1",
        config: {
          provider: "xcodex",
          cwd: "D:\\Dev\\self\\x-codex-worktree",
          model: "auto",
        },
        initialPrompt: "hello",
        clientMessageId: "message-1",
      }),
    ).resolves.toMatchObject({
      id: "xcodex:workspace-1:thread-delayed",
      model: "model-1",
    });
    expect(requests).toContainEqual(
      expect.objectContaining({
        kind: "thread.create",
        payload: expect.objectContaining({
          workspaceId: "workspace-1",
          providerId: "provider-1",
          supplierId: "supplier-1",
          modelId: "model-1",
          text: "hello",
          messageId: "message-1",
        }),
      }),
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
