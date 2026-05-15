import { promises as fs } from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { createConnection } from "node:net";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type pino from "pino";
import type {
  AgentSnapshotPayload,
  ProjectPlacementPayload,
  SessionOutboundMessage,
  SessionInboundMessage,
  WorkspaceDescriptorPayload,
} from "./messages.js";
import type { AgentTimelineRow } from "./agent/agent-timeline-store-types.js";
import { projectTimelineRows, type TimelineProjectionMode } from "./agent/timeline-projection.js";
import {
  deriveAgentStateBucket,
  getWorkspaceStateBucketPriority,
} from "../shared/agent-state-bucket.js";
import { SortablePager } from "./pagination/sortable-pager.js";

const XCODEX_AGENT_PROVIDER = "xcodex";
const XCODEX_AGENT_PREFIX = "xcodex:";
const DEFAULT_ROAMING_INFO_FILE = path.join(
  process.env.APPDATA ?? path.join(homedir(), "AppData", "Roaming"),
  "ai.xcodex.citizenl",
  "xcodex-host-bridge.json",
);
const DEFAULT_LOCAL_INFO_FILE = path.join(
  process.env.LOCALAPPDATA ?? path.join(homedir(), "AppData", "Local"),
  "ai.xcodex.citizenl",
  "xcodex-host-bridge.json",
);

const HostBridgeInfoSchema = z.object({
  protocolVersion: z.number().int().positive().optional(),
  protocol_version: z.number().int().positive().optional(),
  port: z.number().int().positive(),
  token: z.string().min(1),
  pid: z.number().int().nonnegative().optional(),
  startedAtMs: z.number().int().nonnegative().optional(),
  started_at_ms: z.number().int().nonnegative().optional(),
});

const HostBridgeAgentSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  workspaceName: z.string().min(1),
  cwd: z.string().min(1),
  threadId: z.string().min(1),
  title: z.string().nullable().optional(),
  preview: z.string().nullable().optional(),
  modelProvider: z.string().nullable().optional(),
  createdAtMs: z.number().int().nonnegative(),
  updatedAtMs: z.number().int().nonnegative(),
  archivedAtMs: z.number().int().nonnegative().nullable().optional(),
  state: z.string(),
});

const HostBridgeTimelineEntrySchema = z.object({
  seq: z.number().int().nonnegative(),
  timestamp: z.string(),
  kind: z.enum(["user_message", "assistant_message", "reasoning", "tool_call"]),
  text: z.string(),
  messageId: z.string().nullable().optional(),
  callId: z.string().nullable().optional(),
  name: z.string().nullable().optional(),
  status: z.enum(["running", "completed", "failed", "canceled"]).nullable().optional(),
  error: z.string().nullable().optional(),
  detail: z.unknown().optional(),
});

const HostBridgeTimelineSchema = z.object({
  agentId: z.string(),
  epoch: z.string(),
  minSeq: z.number().int().nonnegative(),
  maxSeq: z.number().int().nonnegative(),
  nextSeq: z.number().int().nonnegative(),
  entries: z.array(HostBridgeTimelineEntrySchema),
});

const HostBridgeResponseSchema = z.object({
  ok: z.boolean(),
  data: z.unknown().optional(),
  error: z.string().optional(),
});

const HostBridgeV2ResponseSchema = z.object({
  kind: z.literal("response"),
  id: z.string().nullable().optional(),
  ok: z.boolean(),
  data: z.unknown().optional(),
  error: z
    .union([
      z.string(),
      z.object({
        code: z.string().optional(),
        message: z.string(),
      }),
    ])
    .optional(),
});

const HostBridgeAppServerEventPayloadSchema = z.object({
  workspaceId: z.string().min(1),
  profileId: z.string().min(1),
  sessionKey: z.string().min(1),
  seq: z.number().int().nonnegative().nullable().optional(),
  emittedAtMs: z.number().int().nonnegative().nullable().optional(),
  message: z.unknown(),
});

const HostBridgeV2EventSchema = z.object({
  kind: z.literal("event"),
  seq: z.number().int().nonnegative().nullable().optional(),
  event: z.literal("appServer"),
  payload: HostBridgeAppServerEventPayloadSchema,
});

type HostBridgeAgent = z.infer<typeof HostBridgeAgentSchema>;
type HostBridgeTimeline = z.infer<typeof HostBridgeTimelineSchema>;
type HostBridgeTimelineEntry = z.infer<typeof HostBridgeTimelineEntrySchema>;
export type XcodexBridgeAppServerEvent = z.infer<typeof HostBridgeV2EventSchema>;
type AgentTimelineEntryPayload = Extract<
  SessionOutboundMessage,
  { type: "fetch_agent_timeline_response" }
>["payload"]["entries"][number];
type AgentTimelineDirection = Extract<
  SessionOutboundMessage,
  { type: "fetch_agent_timeline_response" }
>["payload"]["direction"];
type ToolCallTimelineItem = Extract<AgentTimelineEntryPayload["item"], { type: "tool_call" }>;
type ToolCallDetail = ToolCallTimelineItem["detail"];
type FetchWorkspacesRequestMessage = Extract<
  SessionInboundMessage,
  { type: "fetch_workspaces_request" }
>;
type FetchWorkspacesRequestFilter = NonNullable<FetchWorkspacesRequestMessage["filter"]>;
type FetchWorkspacesRequestSort = NonNullable<FetchWorkspacesRequestMessage["sort"]>[number];
type FetchWorkspacesResponsePayload = Extract<
  SessionOutboundMessage,
  { type: "fetch_workspaces_response" }
>["payload"];
type FetchWorkspacesResponseEntry = FetchWorkspacesResponsePayload["entries"][number];
type FetchWorkspacesResponsePageInfo = FetchWorkspacesResponsePayload["pageInfo"];

const FETCH_WORKSPACES_SORT_KEYS = [
  "status_priority",
  "activity_at",
  "name",
  "project_id",
] as const;

export interface XcodexBridgeClient {
  isVirtualAgentId(agentId: string): boolean;
  subscribeEvents(listener: (event: XcodexBridgeAppServerEvent) => void): () => void;
  listAgentPayloads(limit?: number): Promise<AgentSnapshotPayload[]>;
  listWorkspacePayloads(request: FetchWorkspacesRequestMessage): Promise<{
    entries: FetchWorkspacesResponseEntry[];
    pageInfo: FetchWorkspacesResponsePageInfo;
  }>;
  getAgentPayloadById(agentId: string): Promise<AgentSnapshotPayload | null>;
  buildProjectPlacement(agent: AgentSnapshotPayload): ProjectPlacementPayload;
  fetchTimeline(params: {
    agentId: string;
    direction?: AgentTimelineDirection;
    projection?: TimelineProjectionMode;
    cursor?: number;
    limit?: number;
  }): Promise<{
    agent: AgentSnapshotPayload;
    epoch: string;
    window: { minSeq: number; maxSeq: number; nextSeq: number };
    entries: AgentTimelineEntryPayload[];
  } | null>;
  sendMessage(params: {
    agentId: string;
    text: string;
    messageId?: string;
    inputItems?: unknown[];
  }): Promise<{ accepted: boolean; turnId?: string | null; reason?: string | null }>;
  cancelAgent(agentId: string): Promise<{
    accepted: boolean;
    turnId?: string | null;
    reason?: string | null;
  }>;
}

function toIso(ms: number): string {
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? new Date(0).toISOString() : date.toISOString();
}

function titleFor(agent: HostBridgeAgent): string {
  return agent.title?.trim() || agent.preview?.trim() || agent.threadId.slice(0, 8);
}

function capabilities(): AgentSnapshotPayload["capabilities"] {
  return {
    supportsStreaming: true,
    supportsSessionPersistence: true,
    supportsDynamicModes: false,
    supportsMcpServers: false,
    supportsReasoningStream: true,
    supportsToolInvocations: true,
  };
}

function toAgentPayload(agent: HostBridgeAgent): AgentSnapshotPayload {
  return {
    id: agent.id,
    provider: XCODEX_AGENT_PROVIDER,
    cwd: agent.cwd,
    model: agent.modelProvider ?? "xCodex",
    createdAt: toIso(agent.createdAtMs),
    updatedAt: toIso(agent.updatedAtMs),
    lastUserMessageAt: null,
    status: "closed",
    capabilities: capabilities(),
    currentModeId: null,
    availableModes: [],
    pendingPermissions: [],
    persistence: {
      provider: XCODEX_AGENT_PROVIDER,
      sessionId: agent.threadId,
      metadata: {
        xcodex: true,
        workspaceId: agent.workspaceId,
        threadId: agent.threadId,
      },
    },
    runtimeInfo: {
      provider: XCODEX_AGENT_PROVIDER,
      sessionId: agent.threadId,
      model: agent.modelProvider ?? null,
      extra: {
        xcodex: true,
        workspaceId: agent.workspaceId,
        workspaceName: agent.workspaceName,
        readOnly: false,
      },
    },
    title: titleFor(agent),
    labels: {
      "xcodex.kind": "thread",
      "xcodex.workspaceId": agent.workspaceId,
      "xcodex.workspaceName": agent.workspaceName,
      "xcodex.threadId": agent.threadId,
      "xcodex.readOnly": "false",
    },
    archivedAt: agent.archivedAtMs ? toIso(agent.archivedAtMs) : null,
  };
}

function normalizeUnknownToolDetail(detail: unknown, fallbackText: string): ToolCallDetail {
  const record = detail && typeof detail === "object" && !Array.isArray(detail) ? detail : null;
  const input = record && "input" in record ? (record as { input: unknown }).input : null;
  const output =
    record && "output" in record ? (record as { output: unknown }).output : fallbackText || null;
  if (input !== null || output !== null) {
    return {
      type: "unknown",
      input,
      output,
    };
  }
  return {
    type: "plain_text",
    text: fallbackText,
  };
}

function toTimelineEntry(entry: HostBridgeTimelineEntry): AgentTimelineRow {
  let item: AgentTimelineEntryPayload["item"];
  if (entry.kind === "user_message") {
    item = {
      type: "user_message",
      text: entry.text,
      messageId: entry.messageId ?? undefined,
    };
  } else if (entry.kind === "assistant_message") {
    item = {
      type: "assistant_message",
      text: entry.text,
      messageId: entry.messageId ?? undefined,
    };
  } else if (entry.kind === "reasoning") {
    item = { type: "reasoning", text: entry.text };
  } else {
    const status = entry.status ?? "completed";
    const base = {
      type: "tool_call",
      callId: entry.callId ?? `xcodex-tool-${entry.seq}`,
      name: entry.name ?? "tool",
      detail: normalizeUnknownToolDetail(entry.detail, entry.text),
    } as const;
    let toolItem: ToolCallTimelineItem;
    if (status === "failed") {
      toolItem = {
        ...base,
        status: "failed",
        error: entry.error ?? "Tool failed",
      };
    } else if (status === "canceled") {
      toolItem = {
        ...base,
        status: "canceled",
        error: null,
      };
    } else if (status === "running") {
      toolItem = {
        ...base,
        status: "running",
        error: null,
      };
    } else {
      toolItem = {
        ...base,
        status: "completed",
        error: null,
      };
    }
    item = toolItem;
  }
  return {
    item,
    timestamp: entry.timestamp,
    seq: entry.seq,
  };
}

function toProjectedTimelineEntries(
  provider: string,
  entries: HostBridgeTimelineEntry[],
  projection: TimelineProjectionMode,
): AgentTimelineEntryPayload[] {
  return projectTimelineRows({
    rows: entries.map((entry) => toTimelineEntry(entry)),
    mode: projection,
  }).map((entry) => ({
    provider,
    item: entry.item,
    timestamp: entry.timestamp,
    seqStart: entry.seqStart,
    seqEnd: entry.seqEnd,
    sourceSeqRanges: entry.sourceSeqRanges,
    collapsed: entry.collapsed,
  }));
}

const workspacePager = new SortablePager<
  WorkspaceDescriptorPayload,
  FetchWorkspacesRequestSort["key"]
>({
  validKeys: FETCH_WORKSPACES_SORT_KEYS,
  defaultSort: [{ key: "activity_at", direction: "desc" }],
  label: "fetch_workspaces",
  getId: (workspace) => workspace.id,
  getSortValue: (workspace, key) => {
    switch (key) {
      case "status_priority":
        return getWorkspaceStateBucketPriority(workspace.status);
      case "activity_at":
        return workspace.activityAt ? Date.parse(workspace.activityAt) : null;
      case "name":
        return workspace.name.toLocaleLowerCase();
      case "project_id":
        return workspace.projectId.toLocaleLowerCase();
      default:
        throw new Error("unreachable");
    }
  },
});

function matchesWorkspaceFilter(input: {
  workspace: WorkspaceDescriptorPayload;
  filter: FetchWorkspacesRequestFilter | undefined;
}): boolean {
  const { workspace, filter } = input;
  if (!filter) {
    return true;
  }
  if (filter.projectId && filter.projectId.trim().length > 0) {
    if (workspace.projectId !== filter.projectId.trim()) {
      return false;
    }
  }
  if (filter.idPrefix && filter.idPrefix.trim().length > 0) {
    if (!workspace.id.startsWith(filter.idPrefix.trim())) {
      return false;
    }
  }
  if (filter.query && filter.query.trim().length > 0) {
    const query = filter.query.trim().toLocaleLowerCase();
    const haystacks = [
      workspace.name,
      workspace.projectId,
      workspace.id,
      workspace.projectRootPath,
    ];
    if (!haystacks.some((value) => value.toLocaleLowerCase().includes(query))) {
      return false;
    }
  }
  return true;
}

function selectWorkspaceStatus(
  agents: AgentSnapshotPayload[],
): WorkspaceDescriptorPayload["status"] {
  let selected: WorkspaceDescriptorPayload["status"] = "done";
  for (const agent of agents) {
    const bucket = deriveAgentStateBucket({
      status: agent.status,
      pendingPermissionCount: agent.pendingPermissions?.length ?? 0,
      requiresAttention: agent.requiresAttention,
      attentionReason: agent.attentionReason ?? null,
    });
    if (getWorkspaceStateBucketPriority(bucket) < getWorkspaceStateBucketPriority(selected)) {
      selected = bucket;
    }
  }
  return selected;
}

function maxIso(values: Array<string | null | undefined>): string | null {
  let selected: string | null = null;
  let selectedMs = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    if (!value) {
      continue;
    }
    const ms = Date.parse(value);
    if (!Number.isNaN(ms) && ms > selectedMs) {
      selectedMs = ms;
      selected = value;
    }
  }
  return selected;
}

function groupAgentsByWorkspace(
  agents: AgentSnapshotPayload[],
): Map<string, AgentSnapshotPayload[]> {
  const groups = new Map<string, AgentSnapshotPayload[]>();
  for (const agent of agents) {
    const workspaceId = agent.labels["xcodex.workspaceId"]?.trim();
    if (!workspaceId || agent.archivedAt) {
      continue;
    }
    const group = groups.get(workspaceId) ?? [];
    group.push(agent);
    groups.set(workspaceId, group);
  }
  return groups;
}

function workspaceDescriptorFromAgents(
  workspaceId: string,
  agents: AgentSnapshotPayload[],
  buildProjectPlacement: (agent: AgentSnapshotPayload) => ProjectPlacementPayload,
): WorkspaceDescriptorPayload {
  const representative = agents[0];
  const workspaceName =
    representative?.labels["xcodex.workspaceName"]?.trim() ||
    representative?.title?.trim() ||
    "xCodex";
  const cwd = representative?.cwd ?? workspaceId;
  const project = representative ? buildProjectPlacement(representative) : undefined;
  return {
    id: workspaceId,
    projectId: `xcodex:${workspaceId}`,
    projectDisplayName: workspaceName,
    projectCustomName: null,
    projectRootPath: cwd,
    workspaceDirectory: cwd,
    projectKind: "non_git",
    workspaceKind: "directory",
    name: workspaceName,
    archivingAt: null,
    status: selectWorkspaceStatus(agents),
    activityAt: maxIso(agents.map((agent) => agent.updatedAt)),
    diffStat: null,
    scripts: [],
    gitRuntime: null,
    githubRuntime: null,
    ...(project ? { project } : {}),
  };
}

async function listWorkspacePayloadsFromAgents(params: {
  agents: AgentSnapshotPayload[];
  request: FetchWorkspacesRequestMessage;
  buildProjectPlacement: (agent: AgentSnapshotPayload) => ProjectPlacementPayload;
}): Promise<{
  entries: FetchWorkspacesResponseEntry[];
  pageInfo: FetchWorkspacesResponsePageInfo;
}> {
  const sort = workspacePager.normalizeSort(params.request.sort);
  let entries = Array.from(groupAgentsByWorkspace(params.agents).entries()).map(
    ([workspaceId, agents]) =>
      workspaceDescriptorFromAgents(workspaceId, agents, params.buildProjectPlacement),
  );
  entries = entries.filter((workspace) =>
    matchesWorkspaceFilter({ workspace, filter: params.request.filter }),
  );
  entries.sort((left, right) => workspacePager.compare(left, right, sort));

  const cursorToken = params.request.page?.cursor;
  if (cursorToken) {
    const cursor = workspacePager.decode(cursorToken, sort);
    entries = entries.filter(
      (workspace) => workspacePager.compareWithCursor(workspace, cursor, sort) > 0,
    );
  }

  const limit = params.request.page?.limit ?? 200;
  const pagedEntries = entries.slice(0, limit);
  const hasMore = entries.length > limit;
  const nextCursor =
    hasMore && pagedEntries.length > 0
      ? workspacePager.encode(pagedEntries[pagedEntries.length - 1], sort)
      : null;

  return {
    entries: pagedEntries,
    pageInfo: {
      nextCursor,
      prevCursor: params.request.page?.cursor ?? null,
      hasMore,
    },
  };
}

export function createXcodexBridgeClient(options: {
  logger: pino.Logger;
  infoFile?: string;
}): XcodexBridgeClient {
  const logger = options.logger.child({ module: "xcodex-bridge" });
  const explicitInfoFile = options.infoFile ?? process.env.XCODEX_HOST_BRIDGE_INFO_PATH ?? null;
  const candidateInfoFiles = explicitInfoFile
    ? [explicitInfoFile]
    : [DEFAULT_ROAMING_INFO_FILE, DEFAULT_LOCAL_INFO_FILE];

  async function readInfo() {
    const errors: unknown[] = [];
    for (const infoFile of candidateInfoFiles) {
      try {
        const raw = await fs.readFile(infoFile, "utf8");
        return { info: HostBridgeInfoSchema.parse(JSON.parse(raw)), infoFile };
      } catch (error) {
        errors.push(error);
      }
    }
    throw errors[0] ?? new Error("xCodex host bridge info file not found");
  }

  async function requestV1(kind: string, payload: Record<string, unknown> = {}): Promise<unknown> {
    const { info } = await readInfo();
    return await new Promise<unknown>((resolve, reject) => {
      const client = createConnection({ host: "127.0.0.1", port: info.port });
      const timeout = setTimeout(() => {
        client.destroy();
        reject(new Error("xCodex host bridge request timed out"));
      }, 10_000);
      let buffer = "";
      client.setEncoding("utf8");
      client.on("connect", () => {
        client.write(JSON.stringify({ kind, token: info.token, ...payload }) + "\n");
      });
      client.on("data", (chunk) => {
        buffer += chunk;
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        clearTimeout(timeout);
        client.end();
        try {
          const parsed = HostBridgeResponseSchema.parse(JSON.parse(buffer.slice(0, newline)));
          if (!parsed.ok) {
            reject(new Error(parsed.error ?? "xCodex host bridge request failed"));
            return;
          }
          resolve(parsed.data);
        } catch (error) {
          reject(error);
        }
      });
      client.on("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      client.on("close", () => {
        clearTimeout(timeout);
      });
    });
  }

  function v2ErrorMessage(error: z.infer<typeof HostBridgeV2ResponseSchema>["error"]): string {
    if (!error) return "xCodex host bridge request failed";
    if (typeof error === "string") return error;
    return error.message;
  }

  async function requestV2(kind: string, payload: Record<string, unknown> = {}): Promise<unknown> {
    const { info } = await readInfo();
    return await new Promise<unknown>((resolve, reject) => {
      const client = createConnection({ host: "127.0.0.1", port: info.port });
      const timeout = setTimeout(() => {
        client.destroy();
        reject(new Error("xCodex host bridge v2 request timed out"));
      }, 15_000);
      timeout.unref?.();
      let buffer = "";
      const id = randomUUID();
      client.setEncoding("utf8");
      client.on("connect", () => {
        client.write(
          JSON.stringify({
            kind,
            id,
            token: info.token,
            payload,
          }) + "\n",
        );
      });
      client.on("data", (chunk) => {
        buffer += chunk;
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        clearTimeout(timeout);
        client.end();
        try {
          const parsed = HostBridgeV2ResponseSchema.parse(JSON.parse(buffer.slice(0, newline)));
          if (parsed.id && parsed.id !== id) {
            reject(new Error("xCodex host bridge v2 response id mismatch"));
            return;
          }
          if (!parsed.ok) {
            reject(new Error(v2ErrorMessage(parsed.error)));
            return;
          }
          resolve(parsed.data);
        } catch (error) {
          reject(error);
        }
      });
      client.on("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      client.on("close", () => {
        clearTimeout(timeout);
      });
    });
  }

  async function tryRequest<T>(label: string, fn: () => Promise<T>): Promise<T | null> {
    try {
      return await fn();
    } catch (error) {
      logger.debug(
        { err: error, infoFiles: candidateInfoFiles },
        `xCodex bridge ${label} unavailable`,
      );
      return null;
    }
  }

  const eventListeners = new Set<(event: XcodexBridgeAppServerEvent) => void>();
  let eventSocket: ReturnType<typeof createConnection> | null = null;
  let eventReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let eventSubscriptionOpening = false;
  let lastEventSeq = 0;

  function closeEventSubscription(): void {
    if (eventReconnectTimer) {
      clearTimeout(eventReconnectTimer);
      eventReconnectTimer = null;
    }
    if (eventSocket) {
      eventSocket.destroy();
      eventSocket = null;
    }
    eventSubscriptionOpening = false;
  }

  function scheduleEventSubscriptionReconnect(delayMs = 2_000): void {
    if (eventListeners.size === 0 || eventReconnectTimer) return;
    eventReconnectTimer = setTimeout(() => {
      eventReconnectTimer = null;
      void openEventSubscription();
    }, delayMs);
    eventReconnectTimer.unref?.();
  }

  async function openEventSubscription(): Promise<void> {
    if (eventListeners.size === 0 || eventSocket || eventSubscriptionOpening) return;
    eventSubscriptionOpening = true;
    let info: z.infer<typeof HostBridgeInfoSchema>;
    try {
      ({ info } = await readInfo());
    } catch (error) {
      eventSubscriptionOpening = false;
      logger.debug(
        { err: error, infoFiles: candidateInfoFiles },
        "xCodex bridge event subscription unavailable",
      );
      scheduleEventSubscriptionReconnect();
      return;
    }

    const socket = createConnection({ host: "127.0.0.1", port: info.port });
    eventSocket = socket;
    eventSubscriptionOpening = false;
    const id = randomUUID();
    let buffer = "";
    let acknowledged = false;
    const timeout = setTimeout(() => {
      socket.destroy(new Error("xCodex host bridge event subscription timed out"));
    }, 15_000);
    timeout.unref?.();

    socket.setEncoding("utf8");
    socket.on("connect", () => {
      socket.write(
        JSON.stringify({
          kind: "events.subscribe",
          id,
          token: info.token,
          payload: { afterSeq: lastEventSeq },
        }) + "\n",
      );
    });
    socket.on("data", (chunk) => {
      buffer += chunk;
      while (true) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!acknowledged) {
          acknowledged = true;
          clearTimeout(timeout);
        }
        try {
          const parsed = JSON.parse(line);
          const response = HostBridgeV2ResponseSchema.safeParse(parsed);
          if (response.success) {
            if (!response.data.ok) {
              throw new Error(v2ErrorMessage(response.data.error));
            }
            continue;
          }
          const event = HostBridgeV2EventSchema.parse(parsed);
          if (typeof event.seq === "number") {
            lastEventSeq = Math.max(lastEventSeq, event.seq);
          } else if (typeof event.payload.seq === "number") {
            lastEventSeq = Math.max(lastEventSeq, event.payload.seq);
          }
          for (const listener of Array.from(eventListeners)) {
            listener(event);
          }
        } catch (error) {
          logger.debug({ err: error }, "xCodex bridge ignored malformed event frame");
        }
      }
    });
    socket.on("error", (error) => {
      logger.debug({ err: error }, "xCodex bridge event subscription error");
    });
    socket.on("close", () => {
      clearTimeout(timeout);
      if (eventSocket === socket) {
        eventSocket = null;
      }
      if (eventListeners.size > 0) {
        scheduleEventSubscriptionReconnect();
      }
    });
  }

  return {
    isVirtualAgentId(agentId: string) {
      return agentId.startsWith(XCODEX_AGENT_PREFIX);
    },
    subscribeEvents(listener) {
      eventListeners.add(listener);
      void openEventSubscription();
      return () => {
        eventListeners.delete(listener);
        if (eventListeners.size === 0) {
          closeEventSubscription();
        }
      };
    },
    async listAgentPayloads(limit = 200) {
      const data = await tryRequest("listAgents", async () => requestV1("listAgents", { limit }));
      const parsed = z.object({ agents: z.array(HostBridgeAgentSchema) }).safeParse(data);
      return parsed.success ? parsed.data.agents.map(toAgentPayload) : [];
    },
    async listWorkspacePayloads(request) {
      const agents = await this.listAgentPayloads();
      return listWorkspacePayloadsFromAgents({
        agents,
        request,
        buildProjectPlacement: (agent) => this.buildProjectPlacement(agent),
      });
    },
    async getAgentPayloadById(agentId: string) {
      if (!agentId.startsWith(XCODEX_AGENT_PREFIX)) return null;
      const data = await tryRequest("getAgent", async () => requestV1("getAgent", { agentId }));
      const parsed = z.object({ agent: HostBridgeAgentSchema.nullable() }).safeParse(data);
      return parsed.success && parsed.data.agent ? toAgentPayload(parsed.data.agent) : null;
    },
    buildProjectPlacement(agent: AgentSnapshotPayload): ProjectPlacementPayload {
      const projectName = agent.labels["xcodex.workspaceName"] ?? "xCodex";
      return {
        projectKey: `xcodex:${agent.labels["xcodex.workspaceId"] ?? agent.cwd}`,
        projectName,
        checkout: {
          cwd: agent.cwd,
          isGit: false,
          currentBranch: null,
          remoteUrl: null,
          worktreeRoot: null,
          isPaseoOwnedWorktree: false,
          mainRepoRoot: null,
        },
      };
    },
    async fetchTimeline({ agentId, direction, projection = "projected", cursor, limit }) {
      if (!agentId.startsWith(XCODEX_AGENT_PREFIX)) return null;
      const data = await tryRequest("fetchTimeline", async () =>
        requestV1("fetchTimeline", { agentId, direction, cursor, limit }),
      );
      const parsed = z.object({ timeline: HostBridgeTimelineSchema.nullable() }).safeParse(data);
      if (!parsed.success || !parsed.data.timeline) return null;
      const agent = await this.getAgentPayloadById(agentId);
      if (!agent) return null;
      const timeline: HostBridgeTimeline = parsed.data.timeline;
      return {
        agent,
        epoch: timeline.epoch,
        window: {
          minSeq: timeline.minSeq,
          maxSeq: timeline.maxSeq,
          nextSeq: timeline.nextSeq,
        },
        entries: toProjectedTimelineEntries(agent.provider, timeline.entries, projection),
      };
    },
    async sendMessage({ agentId, text, messageId, inputItems }) {
      if (!agentId.startsWith(XCODEX_AGENT_PREFIX)) {
        throw new Error(`Not an xCodex virtual agent: ${agentId}`);
      }
      const data = await requestV2("message.send", {
        agentId,
        text,
        messageId,
        ...(inputItems ? { inputItems } : {}),
      });
      return z
        .object({
          accepted: z.boolean(),
          turnId: z.string().nullable().optional(),
          reason: z.string().nullable().optional(),
        })
        .parse(data);
    },
    async cancelAgent(agentId) {
      if (!agentId.startsWith(XCODEX_AGENT_PREFIX)) {
        throw new Error(`Not an xCodex virtual agent: ${agentId}`);
      }
      const data = await requestV2("turn.interrupt", { agentId });
      return z
        .object({
          accepted: z.boolean(),
          turnId: z.string().nullable().optional(),
          reason: z.string().nullable().optional(),
        })
        .parse(data);
    },
  };
}
