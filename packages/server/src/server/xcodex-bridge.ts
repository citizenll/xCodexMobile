import { promises as fs } from "node:fs";
import path from "node:path";
import { homedir, tmpdir } from "node:os";
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
import { renderPromptAttachmentAsText } from "./agent/prompt-attachments.js";
import {
  deriveAgentStateBucket,
  getWorkspaceStateBucketPriority,
} from "../shared/agent-state-bucket.js";
import type {
  AgentAttachment,
  CreateAgentRequestMessage,
  SendAgentMessageRequest,
} from "../shared/messages.js";
import type { AgentModelDefinition, ProviderSnapshotEntry } from "./agent/agent-sdk-types.js";
import { SortablePager } from "./pagination/sortable-pager.js";

const XCODEX_AGENT_PROVIDER = "xcodex";
const XCODEX_AGENT_PREFIX = "xcodex:";
const XCODEX_ROUTE_MODEL_PREFIX = "xcodex-route:";
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
const XCODEX_MOBILE_ATTACHMENT_DIR = "xcodex-mobile-attachments";
const HOST_BRIDGE_V1_REQUEST_TIMEOUT_MS = 10_000;
const HOST_BRIDGE_V2_DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const HOST_BRIDGE_V2_MESSAGE_SEND_REQUEST_TIMEOUT_MS = 45_000;
const HOST_BRIDGE_V2_THREAD_CREATE_REQUEST_TIMEOUT_MS = 130_000;
const HOST_BRIDGE_V2_EVENT_SUBSCRIBE_TIMEOUT_MS = 15_000;

export interface XcodexBridgeClientTimeouts {
  v1RequestMs?: number;
  v2DefaultRequestMs?: number;
  v2MessageSendRequestMs?: number;
  v2ThreadCreateRequestMs?: number;
  v2EventSubscribeMs?: number;
}

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
  providerId: z.string().nullable().optional(),
  supplierId: z.string().nullable().optional(),
  sessionProfileId: z.string().nullable().optional(),
  modelId: z.string().nullable().optional(),
  realProviderOverride: z.string().nullable().optional(),
  routeUpdatedAtMs: z.number().int().nonnegative().nullable().optional(),
  canSwitchRuntime: z.boolean().optional(),
  runtimeBlockingReason: z.string().nullable().optional(),
  createdAtMs: z.number().int().nonnegative(),
  updatedAtMs: z.number().int().nonnegative(),
  archivedAtMs: z.number().int().nonnegative().nullable().optional(),
  state: z.string(),
});

const HostBridgeRuntimeRouteSchema = z.object({
  workspaceId: z.string().min(1),
  threadId: z.string().min(1),
  providerId: z.string().nullable().optional(),
  supplierId: z.string().nullable().optional(),
  sessionProfileId: z.string().nullable().optional(),
  modelId: z.string().nullable().optional(),
  realProviderOverride: z.string().nullable().optional(),
  updatedAtMs: z.number().int().nonnegative(),
  canSwitchNow: z.boolean(),
  blockingReason: z.string().nullable().optional(),
});

const HostBridgeRuntimeModelSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  providerId: z.string().min(1),
  supplierId: z.string().min(1),
  contextWindow: z.number().int().positive().nullable().optional(),
  inputModalities: z.array(z.string()).optional(),
  supportsFastServiceTier: z.boolean().optional(),
  disabledReason: z.string().nullable().optional(),
});

const HostBridgeRuntimeCatalogSchema = z.object({
  generatedAtMs: z.number().int().nonnegative(),
  providers: z.array(
    z.object({
      id: z.string().min(1),
      label: z.string().min(1),
      description: z.string().nullable().optional(),
      defaultSupplierId: z.string().nullable().optional(),
      supportsSupplierSwitching: z.boolean().optional(),
    }),
  ),
  suppliers: z.array(
    z.object({
      id: z.string().min(1),
      label: z.string().min(1),
      wireApi: z.string(),
      endpointLabel: z.string().nullable().optional(),
      configured: z.boolean().optional(),
      capability: z.string().optional(),
      inputModalities: z.array(z.string()).optional(),
      contextWindow: z.number().int().positive().nullable().optional(),
    }),
  ),
  route: HostBridgeRuntimeRouteSchema.nullable().optional(),
  models: z.array(HostBridgeRuntimeModelSchema).optional(),
});

const XcodexRouteModelRefSchema = z.object({
  providerId: z.string().min(1),
  supplierId: z.string().min(1),
  modelId: z.string().min(1),
  realProviderOverride: z.string().nullable().optional(),
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
type HostBridgeRuntimeRoute = z.infer<typeof HostBridgeRuntimeRouteSchema>;
type HostBridgeRuntimeModel = z.infer<typeof HostBridgeRuntimeModelSchema>;
type HostBridgeRuntimeCatalog = z.infer<typeof HostBridgeRuntimeCatalogSchema>;
type XcodexRouteModelRef = z.infer<typeof XcodexRouteModelRefSchema>;
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
type FileExplorerRequestMessage = Extract<SessionInboundMessage, { type: "file_explorer_request" }>;
type FileExplorerResponsePayload = Extract<
  SessionOutboundMessage,
  { type: "file_explorer_response" }
>["payload"];
type ProjectIconResponsePayload = Extract<
  SessionOutboundMessage,
  { type: "project_icon_response" }
>["payload"];

const FETCH_WORKSPACES_SORT_KEYS = [
  "status_priority",
  "activity_at",
  "name",
  "project_id",
] as const;

const HostBridgeFileExplorerEntrySchema = z.object({
  name: z.string(),
  path: z.string(),
  kind: z.enum(["file", "directory"]),
  size: z.number(),
  modifiedAt: z.string(),
});

const HostBridgeFileExplorerDirectorySchema = z.object({
  path: z.string(),
  entries: z.array(HostBridgeFileExplorerEntrySchema),
});

const HostBridgeFileExplorerFileSchema = z.object({
  path: z.string(),
  kind: z.enum(["text", "image", "binary"]),
  encoding: z.enum(["utf-8", "base64", "none"]),
  content: z.string().optional(),
  mimeType: z.string().optional(),
  size: z.number(),
  modifiedAt: z.string(),
});

const HostBridgeFileExplorerPayloadSchema = z.object({
  cwd: z.string(),
  path: z.string(),
  mode: z.enum(["list", "file"]),
  directory: HostBridgeFileExplorerDirectorySchema.nullable(),
  file: HostBridgeFileExplorerFileSchema.nullable(),
});

const HostBridgeProjectIconPayloadSchema = z.object({
  cwd: z.string(),
  icon: z
    .object({
      data: z.string(),
      mimeType: z.string(),
    })
    .nullable(),
});

const HostBridgeThreadCreateResponseSchema = z.object({
  accepted: z.boolean(),
  agent: HostBridgeAgentSchema,
  threadId: z.string().min(1),
  turnId: z.string().nullable().optional(),
});

function positiveTimeoutMs(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function hostBridgeV2RequestTimeoutMs(kind: string, timeouts?: XcodexBridgeClientTimeouts): number {
  if (kind === "message.send") {
    return positiveTimeoutMs(
      timeouts?.v2MessageSendRequestMs,
      HOST_BRIDGE_V2_MESSAGE_SEND_REQUEST_TIMEOUT_MS,
    );
  }
  if (kind === "thread.create") {
    return positiveTimeoutMs(
      timeouts?.v2ThreadCreateRequestMs,
      HOST_BRIDGE_V2_THREAD_CREATE_REQUEST_TIMEOUT_MS,
    );
  }
  return positiveTimeoutMs(timeouts?.v2DefaultRequestMs, HOST_BRIDGE_V2_DEFAULT_REQUEST_TIMEOUT_MS);
}

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
    images?: SendAgentMessageRequest["images"];
    attachments?: AgentAttachment[];
  }): Promise<{ accepted: boolean; turnId?: string | null; reason?: string | null }>;
  createAgent(params: {
    workspaceId?: string;
    config: CreateAgentRequestMessage["config"];
    initialPrompt?: string;
    clientMessageId?: string;
    images?: CreateAgentRequestMessage["images"];
    attachments?: CreateAgentRequestMessage["attachments"];
  }): Promise<AgentSnapshotPayload>;
  cancelAgent(agentId: string): Promise<{
    accepted: boolean;
    turnId?: string | null;
    reason?: string | null;
  }>;
  fileExplorer(
    params: Pick<FileExplorerRequestMessage, "cwd" | "path" | "mode" | "acceptBinary">,
  ): Promise<Omit<FileExplorerResponsePayload, "requestId" | "error">>;
  projectIcon(cwd: string): Promise<Omit<ProjectIconResponsePayload, "requestId" | "error">>;
  runtimeCatalog(params?: {
    agentId?: string;
    workspaceId?: string;
    threadId?: string;
    includeModels?: boolean;
  }): Promise<HostBridgeRuntimeCatalog | null>;
  providersSnapshotEntry(): Promise<ProviderSnapshotEntry | null>;
  getThreadRuntime(agentId: string): Promise<HostBridgeRuntimeRoute | null>;
  setThreadRuntime(params: {
    agentId: string;
    providerId: string;
    supplierId: string;
    modelId?: string | null;
    realProviderOverride?: string | null;
    expectedUpdatedAtMs?: number;
  }): Promise<{
    accepted: boolean;
    route: HostBridgeRuntimeRoute;
    agent: AgentSnapshotPayload | null;
  }>;
}

function encodeXcodexRouteModelId(route: XcodexRouteModelRef): string {
  const encoded = Buffer.from(JSON.stringify(route), "utf8").toString("base64url");
  return `${XCODEX_ROUTE_MODEL_PREFIX}${encoded}`;
}

function decodeXcodexRouteModelId(modelId: string | null | undefined): XcodexRouteModelRef | null {
  const trimmed = modelId?.trim();
  if (!trimmed?.startsWith(XCODEX_ROUTE_MODEL_PREFIX)) {
    return null;
  }
  try {
    const raw = Buffer.from(trimmed.slice(XCODEX_ROUTE_MODEL_PREFIX.length), "base64url").toString(
      "utf8",
    );
    const parsed = XcodexRouteModelRefSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function runtimeModelRouteRef(model: HostBridgeRuntimeModel): XcodexRouteModelRef {
  return {
    providerId: model.providerId,
    supplierId: model.supplierId,
    modelId: model.id,
  };
}

function routeMatchesModel(
  route: HostBridgeRuntimeRoute | null | undefined,
  model: HostBridgeRuntimeModel,
): boolean {
  return (
    route?.providerId === model.providerId &&
    route?.supplierId === model.supplierId &&
    route?.modelId === model.id
  );
}

function buildXcodexProviderSnapshotEntry(
  catalog: HostBridgeRuntimeCatalog,
  fetchedAt: string,
): ProviderSnapshotEntry {
  const providerById = new Map(catalog.providers.map((provider) => [provider.id, provider]));
  const supplierById = new Map(catalog.suppliers.map((supplier) => [supplier.id, supplier]));
  let hasDefault = false;
  const models = (catalog.models ?? []).map<AgentModelDefinition>((model, index) => {
    const provider = providerById.get(model.providerId);
    const supplier = supplierById.get(model.supplierId);
    const isDefault = routeMatchesModel(catalog.route, model) || (!catalog.route && index === 0);
    if (isDefault) {
      hasDefault = true;
    }
    const entry: AgentModelDefinition = {
      provider: XCODEX_AGENT_PROVIDER,
      id: encodeXcodexRouteModelId(runtimeModelRouteRef(model)),
      label: [
        provider?.label ?? model.providerId,
        supplier?.label ?? model.supplierId,
        model.label || model.id,
      ].join(" / "),
      metadata: {
        xcodexRuntime: {
          providerId: model.providerId,
          supplierId: model.supplierId,
          modelId: model.id,
          contextWindow: model.contextWindow ?? null,
          inputModalities: model.inputModalities ?? [],
          supportsFastServiceTier: model.supportsFastServiceTier === true,
          disabledReason: model.disabledReason ?? null,
        },
      },
    };
    if (isDefault) {
      entry.isDefault = true;
    }
    return entry;
  });
  if (!hasDefault && models[0]) {
    models[0].isDefault = true;
  }
  return {
    provider: XCODEX_AGENT_PROVIDER,
    status: "ready",
    enabled: true,
    label: "xCodex",
    description: "Remote control for xCodex desktop threads",
    models,
    fetchedAt,
  };
}

function toIso(ms: number): string {
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? new Date(0).toISOString() : date.toISOString();
}

function titleFor(agent: HostBridgeAgent): string {
  return agent.title?.trim() || agent.preview?.trim() || agent.threadId.slice(0, 8);
}

function normalizeImageData(mimeType: string, data: string): { mimeType: string; data: string } {
  const trimmed = data.trim();
  const dataUrlMatch = /^data:([^;,]+);base64,(.*)$/i.exec(trimmed);
  if (dataUrlMatch) {
    return {
      mimeType: dataUrlMatch[1] || mimeType || "image/png",
      data: dataUrlMatch[2] ?? "",
    };
  }
  return { mimeType: mimeType || "image/png", data: trimmed };
}

function imageExtensionForMimeType(mimeType: string): string {
  switch (mimeType.toLowerCase()) {
    case "image/jpeg":
    case "image/jpg":
      return "jpg";
    case "image/webp":
      return "webp";
    case "image/gif":
      return "gif";
    case "image/png":
    default:
      return "png";
  }
}

async function writeXcodexMobileImageAttachment(image: {
  data: string;
  mimeType: string;
}): Promise<string> {
  const normalized = normalizeImageData(image.mimeType, image.data);
  const attachmentsDir = path.join(tmpdir(), XCODEX_MOBILE_ATTACHMENT_DIR);
  await fs.mkdir(attachmentsDir, { recursive: true });
  const filePath = path.join(
    attachmentsDir,
    `${randomUUID()}.${imageExtensionForMimeType(normalized.mimeType)}`,
  );
  await fs.writeFile(filePath, Buffer.from(normalized.data, "base64"));
  return filePath;
}

async function buildXcodexMobileInputItems(params: {
  text: string;
  inputItems?: unknown[];
  images?: SendAgentMessageRequest["images"] | CreateAgentRequestMessage["images"];
  attachments?: AgentAttachment[];
}): Promise<unknown[] | undefined> {
  const hasImages = (params.images?.length ?? 0) > 0;
  const hasAttachments = (params.attachments?.length ?? 0) > 0;
  if (!hasImages && !hasAttachments) {
    return params.inputItems;
  }

  const inputItems = params.inputItems ? [...params.inputItems] : [];
  if (inputItems.length === 0 && params.text.trim().length > 0) {
    inputItems.push({ type: "text", text: params.text, text_elements: [] });
  }

  for (const image of params.images ?? []) {
    const filePath = await writeXcodexMobileImageAttachment(image);
    inputItems.push({ type: "localImage", path: filePath });
  }

  for (const attachment of params.attachments ?? []) {
    const rendered = renderPromptAttachmentAsText(attachment).trim();
    if (rendered.length > 0) {
      inputItems.push({ type: "text", text: rendered, text_elements: [] });
    }
  }

  return inputItems;
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

function firstRouteModelRef(catalog: HostBridgeRuntimeCatalog | null): XcodexRouteModelRef | null {
  const models = catalog?.models ?? [];
  if (models.length === 0) {
    return null;
  }
  const selected =
    models.find((model) => routeMatchesModel(catalog?.route, model)) ??
    models.find((model) => !model.disabledReason) ??
    models[0];
  return selected ? runtimeModelRouteRef(selected) : null;
}

function toAgentPayload(agent: HostBridgeAgent): AgentSnapshotPayload {
  const model = agent.modelId ?? agent.modelProvider ?? "xCodex";
  const canSwitchRuntime = agent.canSwitchRuntime !== false;
  return {
    id: agent.id,
    provider: XCODEX_AGENT_PROVIDER,
    cwd: agent.cwd,
    model,
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
      model,
      extra: {
        xcodex: true,
        workspaceId: agent.workspaceId,
        workspaceName: agent.workspaceName,
        threadId: agent.threadId,
        providerId: agent.providerId ?? null,
        supplierId: agent.supplierId ?? null,
        sessionProfileId: agent.sessionProfileId ?? null,
        modelId: agent.modelId ?? null,
        realProviderOverride: agent.realProviderOverride ?? null,
        routeUpdatedAtMs: agent.routeUpdatedAtMs ?? null,
        canSwitchRuntime,
        runtimeBlockingReason: agent.runtimeBlockingReason ?? null,
        readOnly: false,
      },
    },
    title: titleFor(agent),
    labels: {
      "xcodex.kind": "thread",
      "xcodex.workspaceId": agent.workspaceId,
      "xcodex.workspaceName": agent.workspaceName,
      "xcodex.threadId": agent.threadId,
      "xcodex.providerId": agent.providerId ?? "",
      "xcodex.supplierId": agent.supplierId ?? "",
      "xcodex.modelId": agent.modelId ?? "",
      "xcodex.canSwitchRuntime": String(canSwitchRuntime),
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
  timeouts?: XcodexBridgeClientTimeouts;
}): XcodexBridgeClient {
  const logger = options.logger.child({ module: "xcodex-bridge" });
  const timeouts = options.timeouts;
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
      let completed = false;
      const finish = (fn: () => void) => {
        if (completed) return;
        completed = true;
        fn();
      };
      const timeout = setTimeout(
        () => {
          finish(() => {
            client.destroy();
            reject(new Error("xCodex host bridge request timed out"));
          });
        },
        positiveTimeoutMs(timeouts?.v1RequestMs, HOST_BRIDGE_V1_REQUEST_TIMEOUT_MS),
      );
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
            finish(() => reject(new Error(parsed.error ?? "xCodex host bridge request failed")));
            return;
          }
          finish(() => resolve(parsed.data));
        } catch (error) {
          finish(() => reject(error));
        }
      });
      client.on("error", (error) => {
        clearTimeout(timeout);
        finish(() => reject(error));
      });
      client.on("close", () => {
        clearTimeout(timeout);
        finish(() =>
          reject(new Error(`xCodex host bridge connection closed before response for ${kind}`)),
        );
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
      const timeoutMs = hostBridgeV2RequestTimeoutMs(kind, timeouts);
      const startedAt = Date.now();
      const id = randomUUID();
      let completed = false;
      const finish = (level: "info" | "warn", msg: string, extra: Record<string, unknown> = {}) => {
        if (completed) return;
        completed = true;
        logger[level](
          { kind, requestId: id, timeoutMs, elapsedMs: Date.now() - startedAt, ...extra },
          msg,
        );
      };
      logger.info({ kind, requestId: id, timeoutMs }, "xcodex_host_bridge_v2_request_start");
      const timeout = setTimeout(() => {
        finish("warn", "xcodex_host_bridge_v2_request_timeout");
        client.destroy();
        reject(new Error(`xCodex host bridge v2 request timed out for ${kind}`));
      }, timeoutMs);
      timeout.unref?.();
      let buffer = "";
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
            finish("warn", "xcodex_host_bridge_v2_response_id_mismatch", {
              responseId: parsed.id,
            });
            reject(new Error("xCodex host bridge v2 response id mismatch"));
            return;
          }
          if (!parsed.ok) {
            const errorCode =
              parsed.error && typeof parsed.error === "object" ? parsed.error.code : undefined;
            let errorMessage: string | undefined;
            if (typeof parsed.error === "string") {
              errorMessage = parsed.error;
            } else if (parsed.error && typeof parsed.error === "object") {
              errorMessage = parsed.error.message;
            }
            finish("warn", "xcodex_host_bridge_v2_request_error", {
              code: errorCode,
              error: errorMessage,
            });
            reject(new Error(v2ErrorMessage(parsed.error)));
            return;
          }
          finish("info", "xcodex_host_bridge_v2_request_ok");
          resolve(parsed.data);
        } catch (error) {
          finish("warn", "xcodex_host_bridge_v2_response_parse_failed", { err: error });
          reject(error);
        }
      });
      client.on("error", (error) => {
        clearTimeout(timeout);
        finish("warn", "xcodex_host_bridge_v2_socket_error", { err: error });
        reject(error);
      });
      client.on("close", () => {
        clearTimeout(timeout);
        if (!completed) {
          finish("warn", "xcodex_host_bridge_v2_socket_closed_without_response");
          reject(new Error(`xCodex host bridge v2 connection closed before response for ${kind}`));
        }
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
    const timeout = setTimeout(
      () => {
        socket.destroy(new Error("xCodex host bridge event subscription timed out"));
      },
      positiveTimeoutMs(timeouts?.v2EventSubscribeMs, HOST_BRIDGE_V2_EVENT_SUBSCRIBE_TIMEOUT_MS),
    );
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
    async sendMessage({ agentId, text, messageId, inputItems, images, attachments }) {
      if (!agentId.startsWith(XCODEX_AGENT_PREFIX)) {
        throw new Error(`Not an xCodex virtual agent: ${agentId}`);
      }
      const resolvedInputItems = await buildXcodexMobileInputItems({
        text,
        inputItems,
        images,
        attachments,
      });
      const data = await requestV2("message.send", {
        agentId,
        text,
        messageId,
        ...(resolvedInputItems ? { inputItems: resolvedInputItems } : {}),
      });
      return z
        .object({
          accepted: z.boolean(),
          turnId: z.string().nullable().optional(),
          reason: z.string().nullable().optional(),
        })
        .parse(data);
    },
    async createAgent({
      workspaceId,
      config,
      initialPrompt,
      clientMessageId,
      images,
      attachments,
    }) {
      if (config.provider !== XCODEX_AGENT_PROVIDER) {
        throw new Error(`Not an xCodex provider: ${config.provider}`);
      }
      const catalog = await this.runtimeCatalog({
        ...(workspaceId ? { workspaceId } : {}),
        includeModels: true,
      });
      const route = decodeXcodexRouteModelId(config.model) ?? firstRouteModelRef(catalog);
      if (!route) {
        throw new Error("xCodex runtime catalog has no selectable models");
      }
      const text = initialPrompt?.trim() ?? "";
      const resolvedInputItems = await buildXcodexMobileInputItems({
        text,
        images,
        attachments,
      });
      const hasInitialMessage = text.length > 0 || (resolvedInputItems?.length ?? 0) > 0;
      if (!hasInitialMessage) {
        throw new Error("xCodex thread creation requires an initial message");
      }
      const data = await requestV2("thread.create", {
        ...(workspaceId ? { workspaceId } : {}),
        providerId: route.providerId,
        supplierId: route.supplierId,
        modelId: route.modelId,
        ...(route.realProviderOverride ? { realProviderOverride: route.realProviderOverride } : {}),
        text,
        ...(clientMessageId ? { messageId: clientMessageId } : {}),
        ...(resolvedInputItems ? { inputItems: resolvedInputItems } : {}),
      });
      const parsed = HostBridgeThreadCreateResponseSchema.parse(data);
      if (!parsed.accepted) {
        throw new Error("xCodex thread create was not accepted");
      }
      return toAgentPayload(parsed.agent);
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
    async runtimeCatalog(params = {}) {
      const data = await tryRequest("runtime.catalog", async () =>
        requestV2("runtime.catalog", {
          ...(params.agentId ? { agentId: params.agentId } : {}),
          ...(params.workspaceId ? { workspaceId: params.workspaceId } : {}),
          ...(params.threadId ? { threadId: params.threadId } : {}),
          ...(typeof params.includeModels === "boolean"
            ? { includeModels: params.includeModels }
            : {}),
        }),
      );
      return data ? HostBridgeRuntimeCatalogSchema.parse(data) : null;
    },
    async providersSnapshotEntry() {
      const catalog = await this.runtimeCatalog({ includeModels: true });
      if (!catalog) {
        return null;
      }
      return buildXcodexProviderSnapshotEntry(
        catalog,
        new Date(catalog.generatedAtMs).toISOString(),
      );
    },
    async getThreadRuntime(agentId) {
      if (!agentId.startsWith(XCODEX_AGENT_PREFIX)) {
        throw new Error(`Not an xCodex virtual agent: ${agentId}`);
      }
      const data = await tryRequest("thread.runtime.get", async () =>
        requestV2("thread.runtime.get", { agentId }),
      );
      if (!data) return null;
      const parsed = z.object({ route: HostBridgeRuntimeRouteSchema }).parse(data);
      return parsed.route;
    },
    async setThreadRuntime({
      agentId,
      providerId,
      supplierId,
      modelId,
      realProviderOverride,
      expectedUpdatedAtMs,
    }) {
      if (!agentId.startsWith(XCODEX_AGENT_PREFIX)) {
        throw new Error(`Not an xCodex virtual agent: ${agentId}`);
      }
      const decodedModelRoute = decodeXcodexRouteModelId(modelId);
      const effectiveProviderId = decodedModelRoute?.providerId ?? providerId;
      const effectiveSupplierId = decodedModelRoute?.supplierId ?? supplierId;
      const effectiveModelId = decodedModelRoute?.modelId ?? modelId;
      const effectiveRealProviderOverride =
        decodedModelRoute?.realProviderOverride ?? realProviderOverride;
      const data = await requestV2("thread.runtime.set", {
        agentId,
        providerId: effectiveProviderId,
        supplierId: effectiveSupplierId,
        ...(effectiveModelId === undefined ? {} : { modelId: effectiveModelId }),
        ...(effectiveRealProviderOverride === undefined
          ? {}
          : { realProviderOverride: effectiveRealProviderOverride }),
        ...(typeof expectedUpdatedAtMs === "number" ? { expectedUpdatedAtMs } : {}),
      });
      const parsed = z
        .object({
          accepted: z.boolean(),
          route: HostBridgeRuntimeRouteSchema,
          agent: HostBridgeAgentSchema.nullable().optional(),
        })
        .parse(data);
      return {
        accepted: parsed.accepted,
        route: parsed.route,
        agent: parsed.agent ? toAgentPayload(parsed.agent) : null,
      };
    },
    async fileExplorer({ cwd, path: explorerPath, mode, acceptBinary }) {
      const data = await requestV2("file.explorer", {
        cwd,
        path: explorerPath,
        mode,
        ...(acceptBinary ? { acceptBinary: true } : {}),
      });
      const payload = HostBridgeFileExplorerPayloadSchema.parse(data);
      return {
        cwd: payload.cwd,
        path: payload.path,
        mode: payload.mode,
        directory: payload.directory,
        file: payload.file,
      };
    },
    async projectIcon(cwd) {
      const data = await requestV2("project.icon", { cwd });
      const payload = HostBridgeProjectIconPayloadSchema.parse(data);
      return {
        cwd: payload.cwd,
        icon: payload.icon,
      };
    },
  };
}
