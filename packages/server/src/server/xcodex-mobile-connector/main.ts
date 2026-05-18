import { createServer, type IncomingMessage } from "node:http";
import { mkdir } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import path from "node:path";
import { WebSocket, WebSocketServer } from "ws";

import {
  buildOfferEndpoints,
  createConnectionOfferV2,
  encodeOfferToFragmentUrl,
} from "../connection-offer.js";
import { loadOrCreateDaemonKeyPair } from "../daemon-keypair.js";
import { acquirePidLock, releasePidLock, updatePidLock } from "../pid-lock.js";
import { startRelayTransport, type RelayTransportController } from "../relay-transport.js";
import { getOrCreateServerId } from "../server-id.js";
import {
  createXcodexBridgeClient,
  type XcodexBridgeAppServerEvent,
  type XcodexBridgeClient,
} from "../xcodex-bridge.js";
import { DEFAULT_APP_BASE_URL, DEFAULT_RELAY_ENDPOINT } from "../../shared/product-defaults.js";
import {
  CreateAgentRequestMessageSchema,
  SendAgentMessageRequestSchema,
  type AgentAttachment,
  type CreateAgentRequestMessage,
  type SendAgentMessageRequest,
} from "../../shared/messages.js";
import {
  createXcodexStreamEventMapper,
  isXcodexTurnLifecycleAppServerEvent,
} from "./stream-events.js";

declare const __XCODEX_CONNECTOR_VERSION__: string;
declare const __XCODEX_CONNECTOR_BUILD_TIME__: string;

const WS_PROTOCOL_VERSION = 1;
const CONNECTOR_VERSION =
  typeof __XCODEX_CONNECTOR_VERSION__ === "string" ? __XCODEX_CONNECTOR_VERSION__ : "dev";
const CONNECTOR_BUILD_TIME =
  typeof __XCODEX_CONNECTOR_BUILD_TIME__ === "string"
    ? __XCODEX_CONNECTOR_BUILD_TIME__
    : new Date(0).toISOString();

interface LoggerLike {
  child(bindings: Record<string, unknown>): LoggerLike;
  debug(obj: object, msg?: string): void;
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

interface SocketLike {
  readonly readyState: number;
  send(data: string | Uint8Array | ArrayBuffer): void;
  close(code?: number, reason?: string): void;
  on(event: "message" | "close" | "error", listener: (...args: unknown[]) => void): void;
  once(event: "close" | "error", listener: (...args: unknown[]) => void): void;
}

interface ListenAddress {
  host: string;
  port: number;
}

interface AgentSnapshot {
  id: string;
  provider: string;
  cwd: string;
  createdAt: string;
  updatedAt: string;
  status: string;
  title?: string | null;
  labels: Record<string, string>;
  archivedAt?: string | null;
  pendingPermissions?: unknown[];
  requiresAttention?: boolean;
  attentionReason?: string | null;
  thinkingOptionId?: string | null;
  effectiveThinkingOptionId?: string | null;
}

interface ProjectPlacement {
  projectKey: string;
  projectName: string;
}

interface AgentFilter {
  labels?: Record<string, string>;
  projectKeys?: string[];
  statuses?: string[];
  includeArchived?: boolean;
  requiresAttention?: boolean;
  thinkingOptionId?: string | null;
}

interface FetchAgentsRequest {
  type: "fetch_agents_request" | "fetch_agent_history_request";
  requestId: string;
  scope?: "active";
  filter?: AgentFilter;
  sort?: Array<{
    key: "status_priority" | "created_at" | "updated_at" | "title";
    direction: "asc" | "desc";
  }>;
  page?: { limit?: number; cursor?: string };
  subscribe?: { subscriptionId?: string };
}

interface FetchWorkspacesRequest {
  type: "fetch_workspaces_request";
  requestId: string;
  filter?: Record<string, unknown>;
  sort?: Array<Record<string, unknown>>;
  page?: { limit?: number; cursor?: string };
  subscribe?: { subscriptionId?: string };
}

interface TimelineRequest {
  type: "fetch_agent_timeline_request";
  requestId: string;
  agentId: string;
  direction?: "tail" | "before" | "after";
  cursor?: { epoch: string; seq: number };
  limit?: number;
  projection?: "projected" | "canonical";
}

interface SendMessageRequest {
  type: "send_agent_message_request";
  requestId: string;
  agentId: string;
  text: string;
  messageId?: string;
  images?: SendAgentMessageRequest["images"];
  attachments?: AgentAttachment[];
}

interface CreateAgentRequest {
  type: "create_agent_request";
  requestId: string;
  workspaceId?: string;
  config: CreateAgentRequestMessage["config"];
  initialPrompt?: string;
  clientMessageId?: string;
  images?: CreateAgentRequestMessage["images"];
  attachments?: CreateAgentRequestMessage["attachments"];
}

interface CancelAgentRequest {
  type: "cancel_agent_request";
  requestId?: string;
  agentId: string;
}

interface SetAgentModelRequest {
  type: "set_agent_model_request";
  requestId: string;
  agentId: string;
  modelId: string | null;
}

interface ProvidersSnapshotRequest {
  type: "get_providers_snapshot_request";
  requestId: string;
  cwd?: string;
}

interface RefreshProvidersSnapshotRequest {
  type: "refresh_providers_snapshot_request";
  requestId: string;
  cwd?: string;
  providers?: string[];
}

interface XcodexRuntimeCatalogRequest {
  type: "xcodex_runtime_catalog_request";
  requestId: string;
  agentId: string;
  includeModels?: boolean;
}

interface XcodexThreadRuntimeSetRequest {
  type: "xcodex_thread_runtime_set_request";
  requestId: string;
  agentId: string;
  providerId: string;
  supplierId: string;
  modelId?: string | null;
  realProviderOverride?: string | null;
  expectedUpdatedAtMs?: number;
}

interface FileExplorerRequest {
  type: "file_explorer_request";
  requestId: string;
  cwd: string;
  path?: string;
  mode: "list" | "file";
  acceptBinary?: boolean;
}

interface ProjectIconRequest {
  type: "project_icon_request";
  requestId: string;
  cwd: string;
}

type SessionRequest =
  | FetchAgentsRequest
  | FetchWorkspacesRequest
  | TimelineRequest
  | SendMessageRequest
  | CreateAgentRequest
  | CancelAgentRequest
  | SetAgentModelRequest
  | ProvidersSnapshotRequest
  | RefreshProvidersSnapshotRequest
  | XcodexRuntimeCatalogRequest
  | XcodexThreadRuntimeSetRequest
  | FileExplorerRequest
  | ProjectIconRequest
  | { type: "fetch_agent_request"; requestId: string; agentId: string }
  | { type: "ping"; requestId: string; clientSentAt?: number }
  | { type: "client_heartbeat" }
  | { type: "register_push_token"; token?: string }
  | { type: "audio_played"; id?: string }
  | { type: "set_voice_mode"; requestId?: string; enabled?: boolean; agentId?: string }
  | {
      type: "rejected_request";
      requestId?: string;
      originalType: string;
      code: "invalid_request" | "unsupported_request";
      error: string;
    };

interface ServerOptions {
  paseoHome: string;
  listen: ListenAddress;
  relayEnabled: boolean;
  relayEndpoint: string;
  relayUseTls: boolean;
  appBaseUrl: string;
  realtimeStreamingEnabled: boolean;
  logger: LoggerLike;
}

interface ActiveSubscription<TRequest> {
  subscriptionId: string;
  request: TRequest;
}

interface MobileClientConnectionTracker {
  connected(connectionId: string, clientId: string): void;
  seen(connectionId: string): void;
  disconnected(connectionId: string): void;
}

function createLogger(bindings: Record<string, unknown> = {}): LoggerLike {
  const minLevel = process.env.PASEO_CONNECTOR_LOG_LEVEL?.trim().toLowerCase() || "info";
  const ranks: Record<string, number> = { debug: 10, info: 20, warn: 30, error: 40 };
  const minRank = ranks[minLevel] ?? ranks.info;

  function write(level: keyof typeof ranks, obj: object, msg?: string) {
    if (ranks[level] < minRank) return;
    const line = {
      level,
      time: new Date().toISOString(),
      ...bindings,
      msg,
      ...obj,
    };
    const text = JSON.stringify(line);
    if (level === "error") {
      console.error(text);
    } else if (level === "warn") {
      console.warn(text);
    } else {
      console.log(text);
    }
  }

  return {
    child(nextBindings) {
      return createLogger({ ...bindings, ...nextBindings });
    },
    debug: (obj, msg) => write("debug", obj, msg),
    info: (obj, msg) => write("info", obj, msg),
    warn: (obj, msg) => write("warn", obj, msg),
    error: (obj, msg) => write("error", obj, msg),
  };
}

function createSilentLogger(): LoggerLike {
  return {
    child() {
      return this;
    },
    debug() {},
    info() {},
    warn() {},
    error() {},
  };
}

function getEnvString(name: string, fallback: string): string {
  const value = process.env[name]?.trim();
  return value ? value : fallback;
}

function getEnvBoolean(name: string, fallback: boolean): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) return fallback;
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  return fallback;
}

function resolvePaseoHome(): string {
  return getEnvString("PASEO_HOME", path.join(homedir(), ".paseo"));
}

function parseListenAddress(raw: string): ListenAddress {
  const input = raw.trim();
  if (!input) {
    throw new Error("PASEO_LISTEN is empty");
  }

  if (input.startsWith("[")) {
    const end = input.indexOf("]");
    if (end < 0 || input[end + 1] !== ":") {
      throw new Error(`Invalid listen address: ${raw}`);
    }
    return normalizeListenAddress(input.slice(1, end), input.slice(end + 2), raw);
  }

  const splitAt = input.lastIndexOf(":");
  if (splitAt <= 0) {
    throw new Error(`Invalid listen address: ${raw}`);
  }
  return normalizeListenAddress(input.slice(0, splitAt), input.slice(splitAt + 1), raw);
}

function normalizeListenAddress(host: string, portText: string, raw: string): ListenAddress {
  const parsedPort = Number(portText);
  if (!host.trim() || !Number.isInteger(parsedPort) || parsedPort < 0 || parsedPort > 65535) {
    throw new Error(`Invalid listen address: ${raw}`);
  }
  return { host: host.trim(), port: parsedPort };
}

function formatListenAddress(
  address: ReturnType<ReturnType<typeof createServer>["address"]>,
): string {
  if (!address) {
    throw new Error("Connector listen address is unavailable");
  }
  if (typeof address === "string") {
    return address;
  }
  const host = address.family === "IPv6" ? `[${address.address}]` : address.address;
  return `${host}:${address.port}`;
}

function splitListenEndpoint(endpoint: string): { host: string; port: number } | null {
  const trimmed = endpoint.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("[")) {
    const end = trimmed.indexOf("]");
    if (end < 0 || trimmed[end + 1] !== ":") return null;
    const port = Number(trimmed.slice(end + 2));
    return Number.isInteger(port) ? { host: trimmed.slice(1, end), port } : null;
  }
  const splitAt = trimmed.lastIndexOf(":");
  if (splitAt <= 0) return null;
  const port = Number(trimmed.slice(splitAt + 1));
  return Number.isInteger(port) ? { host: trimmed.slice(0, splitAt), port } : null;
}

function isLoopbackHost(host: string): boolean {
  const normalized = host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  return (
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized.startsWith("127.")
  );
}

function isLoopbackEndpoint(endpoint: string): boolean {
  const parsed = splitListenEndpoint(endpoint);
  return parsed ? isLoopbackHost(parsed.host) : true;
}

function normalizeRequestHostHeader(hostHeader: string | string[] | undefined): string | null {
  const raw = Array.isArray(hostHeader) ? hostHeader[0] : hostHeader;
  const normalized = raw?.trim();
  if (!normalized || normalized.includes("/") || normalized.includes("\\")) return null;
  return splitListenEndpoint(normalized) && !isLoopbackEndpoint(normalized) ? normalized : null;
}

function dedupePreserveOrder(values: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function buildAdvertisedDirectTcpEndpoints(input: {
  configuredListen: ListenAddress;
  actualListen?: string;
  requestHost?: string | string[];
}): string[] {
  const actual = input.actualListen ? splitListenEndpoint(input.actualListen) : null;
  const port = actual?.port ?? input.configuredListen.port;
  if (port <= 0 || input.configuredListen.port <= 0) return [];

  const endpoints = [
    normalizeRequestHostHeader(input.requestHost),
    ...buildOfferEndpoints({ listenHost: input.configuredListen.host, port }),
  ].filter((endpoint): endpoint is string => Boolean(endpoint));

  return dedupePreserveOrder(endpoints).filter((endpoint) => !isLoopbackEndpoint(endpoint));
}

function toText(data: unknown): string {
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data.map((part) => Buffer.from(toText(part)))).toString("utf8");
  }
  return String(data);
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function optionalNullableString(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (value === undefined) return undefined;
  return optionalString(value);
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function optionalRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

type RejectedSessionRequest = Extract<SessionRequest, { type: "rejected_request" }>;

interface ParseContext {
  message: Record<string, unknown>;
  originalType: string;
  requestId?: string;
  reject(code: RejectedSessionRequest["code"], error: string): RejectedSessionRequest;
  requireRequestId(): string | null;
  requireField(name: string): string | null;
}

function createParseContext(message: Record<string, unknown>): ParseContext {
  const originalType = optionalString(message.type) ?? "unknown";
  const requestId = optionalString(message.requestId);
  return {
    message,
    originalType,
    requestId,
    reject: (code, error) => ({ type: "rejected_request", requestId, originalType, code, error }),
    requireRequestId: () => requestId ?? null,
    requireField: (name) => optionalString(message[name]) ?? null,
  };
}

function parsePingRequest(context: ParseContext): SessionRequest {
  const requestId = context.requireRequestId();
  if (!requestId) return context.reject("invalid_request", "ping requires requestId");
  return {
    type: "ping",
    requestId,
    clientSentAt: optionalNumber(context.message.clientSentAt),
  };
}

function parseFetchAgentsRequest(context: ParseContext): SessionRequest {
  const requestId = context.requireRequestId();
  if (!requestId)
    return context.reject("invalid_request", `${context.originalType} requires requestId`);
  const type =
    context.originalType === "fetch_agent_history_request"
      ? "fetch_agent_history_request"
      : "fetch_agents_request";
  return {
    type,
    requestId,
    scope: context.message.scope === "active" ? "active" : undefined,
    filter: optionalRecord(context.message.filter) as AgentFilter | undefined,
    sort: Array.isArray(context.message.sort)
      ? (context.message.sort as FetchAgentsRequest["sort"])
      : undefined,
    page: optionalRecord(context.message.page) as FetchAgentsRequest["page"] | undefined,
    subscribe: optionalRecord(context.message.subscribe) as
      | FetchAgentsRequest["subscribe"]
      | undefined,
  };
}

function parseFetchAgentRequest(context: ParseContext): SessionRequest {
  const requestId = context.requireRequestId();
  const agentId = context.requireField("agentId");
  if (!requestId || !agentId) {
    return context.reject("invalid_request", "fetch_agent_request requires requestId and agentId");
  }
  return { type: "fetch_agent_request", requestId, agentId };
}

function parseFetchWorkspacesRequest(context: ParseContext): SessionRequest {
  const requestId = context.requireRequestId();
  if (!requestId)
    return context.reject("invalid_request", "fetch_workspaces_request requires requestId");
  return {
    type: "fetch_workspaces_request",
    requestId,
    filter: optionalRecord(context.message.filter),
    sort: Array.isArray(context.message.sort)
      ? (context.message.sort as FetchWorkspacesRequest["sort"])
      : undefined,
    page: optionalRecord(context.message.page) as FetchWorkspacesRequest["page"] | undefined,
    subscribe: optionalRecord(context.message.subscribe) as
      | FetchWorkspacesRequest["subscribe"]
      | undefined,
  };
}

function parseTimelineRequest(context: ParseContext): SessionRequest {
  const requestId = context.requireRequestId();
  const agentId = context.requireField("agentId");
  if (!requestId || !agentId) {
    return context.reject(
      "invalid_request",
      "fetch_agent_timeline_request requires requestId and agentId",
    );
  }
  return {
    type: "fetch_agent_timeline_request",
    requestId,
    agentId,
    direction: parseTimelineDirection(context.message.direction),
    cursor: optionalRecord(context.message.cursor) as TimelineRequest["cursor"] | undefined,
    limit: optionalNumber(context.message.limit),
    projection: parseTimelineProjection(context.message.projection),
  };
}

function parseTimelineDirection(value: unknown): TimelineRequest["direction"] {
  return value === "tail" || value === "before" || value === "after" ? value : undefined;
}

function parseTimelineProjection(value: unknown): TimelineRequest["projection"] {
  return value === "projected" || value === "canonical" ? value : undefined;
}

function parseSendMessageRequest(context: ParseContext): SessionRequest {
  const requestId = context.requireRequestId();
  const agentId = context.requireField("agentId");
  const text = typeof context.message.text === "string" ? context.message.text : null;
  if (!requestId || !agentId || text === null) {
    return context.reject(
      "invalid_request",
      "send_agent_message_request requires requestId, agentId, and text",
    );
  }
  const parsed = SendAgentMessageRequestSchema.safeParse({
    ...context.message,
    type: "send_agent_message_request",
    requestId,
    agentId,
    text,
  });
  if (!parsed.success) {
    return context.reject("invalid_request", "send_agent_message_request payload is invalid");
  }
  return {
    type: "send_agent_message_request",
    requestId,
    agentId,
    text,
    messageId: optionalString(context.message.messageId),
    images: parsed.data.images,
    attachments: parsed.data.attachments,
  };
}

function parseCreateAgentRequest(context: ParseContext): SessionRequest {
  const requestId = context.requireRequestId();
  if (!requestId) {
    return context.reject("invalid_request", "create_agent_request requires requestId");
  }
  const parsed = CreateAgentRequestMessageSchema.safeParse({
    ...context.message,
    type: "create_agent_request",
    requestId,
  });
  if (!parsed.success) {
    return context.reject("invalid_request", "create_agent_request payload is invalid");
  }
  return {
    type: "create_agent_request",
    requestId,
    workspaceId: parsed.data.workspaceId,
    config: parsed.data.config,
    initialPrompt: parsed.data.initialPrompt,
    clientMessageId: parsed.data.clientMessageId,
    images: parsed.data.images,
    attachments: parsed.data.attachments,
  };
}

function parseCancelAgentRequest(context: ParseContext): SessionRequest {
  const agentId = context.requireField("agentId");
  if (!agentId) return context.reject("invalid_request", "cancel_agent_request requires agentId");
  return { type: "cancel_agent_request", requestId: context.requestId, agentId };
}

function parseSetAgentModelRequest(context: ParseContext): SessionRequest {
  const requestId = context.requireRequestId();
  const agentId = context.requireField("agentId");
  const rawModelId = context.message.modelId;
  const modelId = rawModelId === null ? null : optionalString(rawModelId);
  if (!requestId || !agentId || (rawModelId !== null && !modelId)) {
    return context.reject(
      "invalid_request",
      "set_agent_model_request requires requestId, agentId, and modelId",
    );
  }
  return {
    type: "set_agent_model_request",
    requestId,
    agentId,
    modelId: rawModelId === null ? null : modelId!,
  };
}

function parseProvidersSnapshotRequest(context: ParseContext): SessionRequest {
  const requestId = context.requireRequestId();
  if (!requestId) {
    return context.reject("invalid_request", `${context.originalType} requires requestId`);
  }
  if (context.originalType === "refresh_providers_snapshot_request") {
    return {
      type: "refresh_providers_snapshot_request",
      requestId,
      cwd: optionalString(context.message.cwd),
      providers: Array.isArray(context.message.providers)
        ? context.message.providers.filter((value): value is string => typeof value === "string")
        : undefined,
    };
  }
  return {
    type: "get_providers_snapshot_request",
    requestId,
    cwd: optionalString(context.message.cwd),
  };
}

function parseXcodexRuntimeCatalogRequest(context: ParseContext): SessionRequest {
  const requestId = context.requireRequestId();
  const agentId = context.requireField("agentId");
  if (!requestId || !agentId) {
    return context.reject(
      "invalid_request",
      "xcodex_runtime_catalog_request requires requestId and agentId",
    );
  }
  return {
    type: "xcodex_runtime_catalog_request",
    requestId,
    agentId,
    includeModels:
      typeof context.message.includeModels === "boolean" ? context.message.includeModels : true,
  };
}

function parseXcodexThreadRuntimeSetRequest(context: ParseContext): SessionRequest {
  const requestId = context.requireRequestId();
  const agentId = context.requireField("agentId");
  const providerId = context.requireField("providerId");
  const supplierId = context.requireField("supplierId");
  const rawModelId = context.message.modelId;
  const rawRealProviderOverride = context.message.realProviderOverride;
  const expectedUpdatedAtMs =
    typeof context.message.expectedUpdatedAtMs === "number"
      ? context.message.expectedUpdatedAtMs
      : undefined;
  const modelId = optionalNullableString(rawModelId);
  const realProviderOverride = optionalNullableString(rawRealProviderOverride);
  if (!requestId || !agentId || !providerId || !supplierId) {
    return context.reject(
      "invalid_request",
      "xcodex_thread_runtime_set_request requires requestId, agentId, providerId, and supplierId",
    );
  }
  if ((rawModelId !== null && rawModelId !== undefined && !modelId) || modelId === "") {
    return context.reject(
      "invalid_request",
      "xcodex_thread_runtime_set_request modelId is invalid",
    );
  }
  if (
    (rawRealProviderOverride !== null &&
      rawRealProviderOverride !== undefined &&
      !realProviderOverride) ||
    realProviderOverride === ""
  ) {
    return context.reject(
      "invalid_request",
      "xcodex_thread_runtime_set_request realProviderOverride is invalid",
    );
  }
  return {
    type: "xcodex_thread_runtime_set_request",
    requestId,
    agentId,
    providerId,
    supplierId,
    modelId,
    realProviderOverride,
    expectedUpdatedAtMs,
  };
}

function parseFileExplorerRequest(context: ParseContext): SessionRequest {
  const requestId = context.requireRequestId();
  const cwd = context.requireField("cwd");
  const mode = optionalString(context.message.mode);
  if (!requestId || !cwd || (mode !== "list" && mode !== "file")) {
    return context.reject(
      "invalid_request",
      "file_explorer_request requires requestId, cwd, and mode",
    );
  }
  return {
    type: "file_explorer_request",
    requestId,
    cwd,
    path: optionalString(context.message.path),
    mode,
    acceptBinary:
      typeof context.message.acceptBinary === "boolean" ? context.message.acceptBinary : undefined,
  };
}

function parseProjectIconRequest(context: ParseContext): SessionRequest {
  const requestId = context.requireRequestId();
  const cwd = context.requireField("cwd");
  if (!requestId || !cwd) {
    return context.reject("invalid_request", "project_icon_request requires requestId and cwd");
  }
  return {
    type: "project_icon_request",
    requestId,
    cwd,
  };
}

function parseSetVoiceModeRequest(context: ParseContext): SessionRequest {
  return {
    type: "set_voice_mode",
    requestId: context.requestId,
    enabled: typeof context.message.enabled === "boolean" ? context.message.enabled : undefined,
    agentId: optionalString(context.message.agentId),
  };
}

const sessionRequestParsers: Record<string, (context: ParseContext) => SessionRequest> = {
  ping: parsePingRequest,
  fetch_agents_request: parseFetchAgentsRequest,
  fetch_agent_history_request: parseFetchAgentsRequest,
  fetch_agent_request: parseFetchAgentRequest,
  fetch_workspaces_request: parseFetchWorkspacesRequest,
  fetch_agent_timeline_request: parseTimelineRequest,
  send_agent_message_request: parseSendMessageRequest,
  create_agent_request: parseCreateAgentRequest,
  cancel_agent_request: parseCancelAgentRequest,
  set_agent_model_request: parseSetAgentModelRequest,
  get_providers_snapshot_request: parseProvidersSnapshotRequest,
  refresh_providers_snapshot_request: parseProvidersSnapshotRequest,
  xcodex_runtime_catalog_request: parseXcodexRuntimeCatalogRequest,
  xcodex_thread_runtime_set_request: parseXcodexThreadRuntimeSetRequest,
  file_explorer_request: parseFileExplorerRequest,
  project_icon_request: parseProjectIconRequest,
  client_heartbeat: () => ({ type: "client_heartbeat" }),
  register_push_token: (context) => ({
    type: "register_push_token",
    token: optionalString(context.message.token),
  }),
  audio_played: (context) => ({ type: "audio_played", id: optionalString(context.message.id) }),
  set_voice_mode: parseSetVoiceModeRequest,
};

function parseSessionRequest(message: Record<string, unknown>): SessionRequest {
  const context = createParseContext(message);
  const parser = sessionRequestParsers[context.originalType];
  if (!parser) {
    return context.reject(
      "unsupported_request",
      `${context.originalType} is not supported by the xCodex mobile connector`,
    );
  }
  return parser(context);
}

function stringField(record: Record<string, unknown> | null, keys: string[]): string | null {
  if (!record) return null;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

function recordFromUnknown(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ offset }), "utf8").toString("base64url");
}

function decodeCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    return typeof parsed.offset === "number" && parsed.offset >= 0 ? Math.floor(parsed.offset) : 0;
  } catch {
    return 0;
  }
}

function statusPriority(agent: AgentSnapshot): number {
  if ((agent.pendingPermissions?.length ?? 0) > 0 || agent.attentionReason === "permission") {
    return 0;
  }
  if (agent.status === "error" || agent.attentionReason === "error") {
    return 1;
  }
  if (agent.status === "running") {
    return 2;
  }
  if (agent.status === "initializing") {
    return 3;
  }
  return 4;
}

function compareValues(left: number | string | null, right: number | string | null): number {
  if (left === right) return 0;
  if (left === null) return -1;
  if (right === null) return 1;
  if (typeof left === "number" && typeof right === "number") {
    return left < right ? -1 : 1;
  }
  return String(left).localeCompare(String(right));
}

function agentSortValue(agent: AgentSnapshot, key: string): number | string | null {
  if (key === "status_priority") return statusPriority(agent);
  if (key === "created_at") return Date.parse(agent.createdAt);
  if (key === "updated_at") return Date.parse(agent.updatedAt);
  if (key === "title") return agent.title?.toLocaleLowerCase() ?? "";
  return null;
}

function sortAgents(
  agents: AgentSnapshot[],
  sort: FetchAgentsRequest["sort"] | undefined,
): AgentSnapshot[] {
  const normalized =
    sort && sort.length > 0 ? sort : [{ key: "updated_at", direction: "desc" } as const];
  return [...agents].sort((left, right) => {
    for (const spec of normalized) {
      const base = compareValues(agentSortValue(left, spec.key), agentSortValue(right, spec.key));
      if (base !== 0) return spec.direction === "asc" ? base : -base;
    }
    return left.id.localeCompare(right.id);
  });
}

function matchesLabels(agent: AgentSnapshot, labels?: Record<string, string>) {
  if (!labels) return true;
  for (const [key, value] of Object.entries(labels)) {
    if (agent.labels[key] !== value) return false;
  }
  return true;
}

function matchesProjectKey(project: ProjectPlacement, projectKeys?: string[]) {
  if (!projectKeys || projectKeys.length === 0) return true;
  const normalized = new Set(projectKeys.filter((value) => value.trim()));
  return normalized.size === 0 || normalized.has(project.projectKey);
}

function matchesThinkingOption(agent: AgentSnapshot, thinkingOptionId: string | null | undefined) {
  if (thinkingOptionId === undefined) return true;
  const actual = agent.effectiveThinkingOptionId ?? agent.thinkingOptionId ?? null;
  return actual === thinkingOptionId;
}

function matchesAgentFilter(agent: AgentSnapshot, project: ProjectPlacement, filter?: AgentFilter) {
  if (!filter) return !agent.archivedAt;
  if (!matchesLabels(agent, filter.labels)) return false;
  if (!(filter.includeArchived ?? false) && agent.archivedAt) return false;
  if (filter.statuses?.length && !filter.statuses.includes(agent.status)) return false;
  if (
    typeof filter.requiresAttention === "boolean" &&
    (agent.requiresAttention ?? false) !== filter.requiresAttention
  ) {
    return false;
  }
  if (!matchesProjectKey(project, filter.projectKeys)) return false;
  return matchesThinkingOption(agent, filter.thinkingOptionId);
}

function resolveSubscriptionId(
  subscribe: { subscriptionId?: string } | undefined,
  fallbackPrefix: string,
): string | null {
  if (!subscribe) return null;
  return subscribe.subscriptionId?.trim() || `${fallbackPrefix}:${Date.now()}`;
}

function xcodexThreadIdFromEvent(event: XcodexBridgeAppServerEvent): string | null {
  const message = recordFromUnknown(event.payload.message);
  const params = recordFromUnknown(message?.params);
  return (
    stringField(params, ["threadId", "thread_id"]) ??
    stringField(recordFromUnknown(params?.turn), ["threadId", "thread_id"]) ??
    stringField(recordFromUnknown(params?.item), ["threadId", "thread_id"]) ??
    stringField(recordFromUnknown(params?.thread), ["id", "threadId", "thread_id"])
  );
}

function xcodexEventTimestamp(event: XcodexBridgeAppServerEvent): string {
  const emittedAtMs =
    typeof event.payload.emittedAtMs === "number" ? event.payload.emittedAtMs : Date.now();
  return new Date(emittedAtMs).toISOString();
}

class ClientSession {
  private active = false;
  private clientId: string | null = null;
  private disposed = false;
  private agentSubscription: ActiveSubscription<FetchAgentsRequest> | null = null;
  private workspaceSubscription: ActiveSubscription<FetchWorkspacesRequest> | null = null;
  private readonly xcodexStreamEvents: ReturnType<typeof createXcodexStreamEventMapper>;
  private readonly unsubscribeBridgeEvents: () => void;

  constructor(
    private readonly connectionId: string,
    private readonly socket: SocketLike,
    private readonly bridge: XcodexBridgeClient,
    private readonly serverId: string,
    private readonly logger: LoggerLike,
    private readonly tracker: MobileClientConnectionTracker,
    private readonly realtimeStreamingEnabled: boolean,
  ) {
    this.xcodexStreamEvents = createXcodexStreamEventMapper({ realtimeStreamingEnabled });
    this.unsubscribeBridgeEvents = bridge.subscribeEvents((event) => this.handleBridgeEvent(event));
    socket.on("message", (data) => {
      void this.handleRawMessage(data);
    });
    socket.on("close", () => this.dispose());
    socket.on("error", (error) => {
      this.logger.warn({ err: error }, "client_socket_error");
      this.dispose();
    });
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribeBridgeEvents();
    if (this.clientId) {
      this.tracker.disconnected(this.connectionId);
    }
  }

  private markSeen() {
    if (this.clientId) {
      this.tracker.seen(this.connectionId);
    }
  }

  private sendEnvelope(message: Record<string, unknown>) {
    if (this.socket.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify(message));
  }

  private sendSession(message: Record<string, unknown>) {
    this.sendEnvelope({ type: "session", message });
  }

  private sendRpcError(request: SessionRequest, code: string, error: string) {
    if (!("requestId" in request) || !request.requestId) return;
    const requestType = "originalType" in request ? request.originalType : request.type;
    this.sendSession({
      type: "rpc_error",
      payload: {
        requestId: request.requestId,
        requestType,
        code,
        error,
      },
    });
  }

  private async handleRawMessage(data: unknown) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(toText(data));
    } catch (error) {
      this.logger.warn({ err: error }, "invalid_json_message");
      this.socket.close(1003, "Invalid JSON");
      return;
    }
    if (!isRecord(parsed) || typeof parsed.type !== "string") {
      this.socket.close(1003, "Invalid message");
      return;
    }

    if (parsed.type === "ping") {
      this.markSeen();
      this.sendEnvelope({ type: "pong" });
      return;
    }
    if (parsed.type === "recording_state") {
      return;
    }
    if (!this.active) {
      this.handleHello(parsed);
      return;
    }
    this.markSeen();
    if (parsed.type === "hello") {
      this.socket.close(1002, "Unexpected hello");
      return;
    }
    if (parsed.type !== "session" || !isRecord(parsed.message)) {
      this.socket.close(1003, "Invalid session message");
      return;
    }
    await this.handleSessionMessage(parseSessionRequest(parsed.message));
  }

  private handleHello(message: Record<string, unknown>) {
    if (message.type !== "hello") {
      this.socket.close(1002, "Missing hello");
      return;
    }
    if (message.protocolVersion !== WS_PROTOCOL_VERSION) {
      this.socket.close(4002, "Incompatible protocol version");
      return;
    }
    const clientId = typeof message.clientId === "string" ? message.clientId.trim() : "";
    if (!clientId) {
      this.socket.close(4003, "Invalid hello");
      return;
    }
    this.active = true;
    this.clientId = clientId;
    this.tracker.connected(this.connectionId, clientId);
    this.logger.info({ clientId }, "client_connected");
    this.sendSession({
      type: "status",
      payload: {
        status: "server_info",
        serverId: this.serverId,
        hostname: hostname(),
        version: CONNECTOR_VERSION,
        features: {
          providersSnapshot: true,
          xcodexRuntimeCatalog: true,
          xcodexThreadRuntimeSwitching: true,
          checkoutGithubSetAutoMerge: false,
        },
        xcodexConnector: {
          buildTime: CONNECTOR_BUILD_TIME,
        },
      },
    });
  }

  private async handleSessionMessage(message: SessionRequest) {
    try {
      if (await this.handleCoreSessionMessage(message)) return;
      if (await this.handleRuntimeSessionMessage(message)) return;
      this.handleUnsupportedSessionMessage(message);
    } catch (error) {
      this.logger.error({ err: error, type: message.type }, "session_message_failed");
      this.sendRpcError(message, "request_failed", getErrorMessage(error));
    }
  }

  private async handleCoreSessionMessage(message: SessionRequest): Promise<boolean> {
    switch (message.type) {
      case "rejected_request":
        this.sendRpcError(message, message.code, message.error);
        return true;
      case "ping":
        this.sendSession({
          type: "pong",
          payload: {
            requestId: message.requestId,
            clientSentAt: message.clientSentAt,
            serverReceivedAt: Date.now(),
            serverSentAt: Date.now(),
          },
        });
        return true;
      case "fetch_agents_request":
      case "fetch_agent_history_request":
        await this.handleFetchAgents(message);
        return true;
      case "fetch_agent_request":
        await this.handleFetchAgent(message);
        return true;
      case "fetch_workspaces_request":
        await this.handleFetchWorkspaces(message);
        return true;
      case "fetch_agent_timeline_request":
        await this.handleFetchTimeline(message);
        return true;
      case "send_agent_message_request":
        await this.handleSendMessage(message);
        return true;
      case "create_agent_request":
        await this.handleCreateAgent(message);
        return true;
      case "cancel_agent_request":
        await this.handleCancelAgent(message);
        return true;
      default:
        return false;
    }
  }

  private async handleRuntimeSessionMessage(message: SessionRequest): Promise<boolean> {
    switch (message.type) {
      case "set_agent_model_request":
        await this.handleSetAgentModel(message);
        return true;
      case "get_providers_snapshot_request":
        await this.handleGetProvidersSnapshot(message);
        return true;
      case "refresh_providers_snapshot_request":
        await this.handleRefreshProvidersSnapshot(message);
        return true;
      case "xcodex_runtime_catalog_request":
        await this.handleXcodexRuntimeCatalog(message);
        return true;
      case "xcodex_thread_runtime_set_request":
        await this.handleXcodexThreadRuntimeSet(message);
        return true;
      case "file_explorer_request":
        await this.handleFileExplorer(message);
        return true;
      case "project_icon_request":
        await this.handleProjectIcon(message);
        return true;
      case "client_heartbeat":
      case "register_push_token":
      case "audio_played":
        return true;
      default:
        return false;
    }
  }

  private handleUnsupportedSessionMessage(message: SessionRequest) {
    if (message.type !== "set_voice_mode") return;
    this.sendSession({
      type: "set_voice_mode_response",
      payload: {
        requestId: message.requestId ?? `voice-${Date.now()}`,
        enabled: false,
        agentId: message.agentId ?? null,
        accepted: false,
        error: "Voice mode is not available through the xCodex mobile connector.",
        reasonCode: "unsupported_connector_capability",
        retryable: false,
      },
    });
  }

  private async handleFetchAgents(request: FetchAgentsRequest) {
    const subscriptionId = resolveSubscriptionId(request.subscribe, "agents");
    if (subscriptionId) {
      this.agentSubscription = { subscriptionId, request };
    }
    const payload = await this.listAgentEntries(request);
    this.sendSession({
      type:
        request.type === "fetch_agents_request"
          ? "fetch_agents_response"
          : "fetch_agent_history_response",
      payload: {
        requestId: request.requestId,
        ...(subscriptionId ? { subscriptionId } : {}),
        ...payload,
      },
    });
  }

  private async handleFetchAgent(
    request: Extract<SessionRequest, { type: "fetch_agent_request" }>,
  ) {
    const agent = (await this.bridge.getAgentPayloadById(request.agentId)) as AgentSnapshot | null;
    this.sendSession({
      type: "fetch_agent_response",
      payload: {
        requestId: request.requestId,
        agent,
        project: agent ? this.bridge.buildProjectPlacement(agent as never) : null,
        error: agent ? null : `Agent not found: ${request.agentId}`,
      },
    });
  }

  private async listAgentEntries(request: FetchAgentsRequest) {
    const agents = (await this.bridge.listAgentPayloads()) as AgentSnapshot[];
    const entries = sortAgents(agents, request.sort)
      .map((agent) => ({
        agent,
        project: this.bridge.buildProjectPlacement(agent as never) as ProjectPlacement,
      }))
      .filter((entry) => matchesAgentFilter(entry.agent, entry.project, request.filter));
    const offset = decodeCursor(request.page?.cursor);
    const limit = Math.min(Math.max(request.page?.limit ?? 200, 1), 200);
    const pagedEntries = entries.slice(offset, offset + limit);
    const nextOffset = offset + pagedEntries.length;
    return {
      entries: pagedEntries,
      pageInfo: {
        nextCursor: nextOffset < entries.length ? encodeCursor(nextOffset) : null,
        prevCursor: request.page?.cursor ?? null,
        hasMore: nextOffset < entries.length,
      },
    };
  }

  private async handleFetchWorkspaces(request: FetchWorkspacesRequest) {
    const subscriptionId = resolveSubscriptionId(request.subscribe, "workspaces");
    if (subscriptionId) {
      this.workspaceSubscription = { subscriptionId, request };
    }
    const payload = await this.bridge.listWorkspacePayloads(request as never);
    this.sendSession({
      type: "fetch_workspaces_response",
      payload: {
        requestId: request.requestId,
        ...(subscriptionId ? { subscriptionId } : {}),
        ...payload,
      },
    });
  }

  private async handleFetchTimeline(request: TimelineRequest) {
    const direction = request.direction ?? "tail";
    const projection = request.projection ?? "projected";
    const timeline = await this.bridge.fetchTimeline({
      agentId: request.agentId,
      direction,
      projection,
      cursor: request.cursor?.seq,
      limit: request.limit,
    });
    if (!timeline) {
      this.sendTimelineError(request, direction, projection, `Agent not found: ${request.agentId}`);
      return;
    }
    const firstEntry = timeline.entries[0];
    const lastEntry = timeline.entries[timeline.entries.length - 1];
    this.sendSession({
      type: "fetch_agent_timeline_response",
      payload: {
        requestId: request.requestId,
        agentId: request.agentId,
        agent: timeline.agent,
        direction,
        projection,
        epoch: timeline.epoch,
        reset: false,
        staleCursor: false,
        gap: false,
        window: timeline.window,
        startCursor: firstEntry ? { epoch: timeline.epoch, seq: firstEntry.seqStart } : null,
        endCursor: lastEntry ? { epoch: timeline.epoch, seq: lastEntry.seqEnd } : null,
        hasOlder: firstEntry ? firstEntry.seqStart > timeline.window.minSeq : false,
        hasNewer: lastEntry ? lastEntry.seqEnd < timeline.window.maxSeq : false,
        entries: timeline.entries,
        error: null,
      },
    });
  }

  private sendTimelineError(
    request: TimelineRequest,
    direction: "tail" | "before" | "after",
    projection: "projected" | "canonical",
    error: string,
  ) {
    this.sendSession({
      type: "fetch_agent_timeline_response",
      payload: {
        requestId: request.requestId,
        agentId: request.agentId,
        agent: null,
        direction,
        projection,
        epoch: request.agentId,
        reset: false,
        staleCursor: false,
        gap: false,
        window: { minSeq: 0, maxSeq: 0, nextSeq: 0 },
        startCursor: null,
        endCursor: null,
        hasOlder: false,
        hasNewer: false,
        entries: [],
        error,
      },
    });
  }

  private async handleSendMessage(request: SendMessageRequest) {
    const result = await this.bridge.sendMessage({
      agentId: request.agentId,
      text: request.text,
      messageId: request.messageId,
      images: request.images,
      attachments: request.attachments,
    });
    this.sendSession({
      type: "send_agent_message_response",
      payload: {
        requestId: request.requestId,
        agentId: request.agentId,
        accepted: result.accepted,
        error: result.accepted ? null : (result.reason ?? "xCodex turn was not accepted"),
      },
    });
  }

  private async handleCreateAgent(request: CreateAgentRequest) {
    try {
      const agent = (await this.bridge.createAgent({
        workspaceId: request.workspaceId,
        config: request.config,
        initialPrompt: request.initialPrompt,
        clientMessageId: request.clientMessageId,
        images: request.images,
        attachments: request.attachments,
      })) as AgentSnapshot;
      this.sendSession({
        type: "status",
        payload: {
          status: "agent_created",
          requestId: request.requestId,
          agentId: agent.id,
          agent,
        },
      });
      this.sendAgentUpsert(agent);
      const workspaceId = agent.labels["xcodex.workspaceId"];
      if (workspaceId) {
        void this.forwardWorkspaceUpdate(workspaceId);
      }
    } catch (error) {
      this.sendSession({
        type: "status",
        payload: {
          status: "agent_create_failed",
          requestId: request.requestId,
          error: getErrorMessage(error),
        },
      });
    }
  }

  private async handleCancelAgent(request: CancelAgentRequest) {
    await this.bridge.cancelAgent(request.agentId);
    const agent = (await this.bridge.getAgentPayloadById(request.agentId)) as AgentSnapshot | null;
    this.sendSession({
      type: "cancel_agent_response",
      payload: {
        requestId: request.requestId ?? `cancel-${Date.now()}`,
        agentId: request.agentId,
        agent,
      },
    });
  }

  private async handleSetAgentModel(request: SetAgentModelRequest) {
    try {
      const route = await this.bridge.getThreadRuntime(request.agentId);
      if (!route?.providerId || !route.supplierId) {
        throw new Error("xCodex thread runtime route is not selectable");
      }
      const result = await this.bridge.setThreadRuntime({
        agentId: request.agentId,
        providerId: route.providerId,
        supplierId: route.supplierId,
        modelId: request.modelId,
        realProviderOverride: route.realProviderOverride ?? null,
        expectedUpdatedAtMs: route.updatedAtMs,
      });
      this.sendSession({
        type: "set_agent_model_response",
        payload: {
          requestId: request.requestId,
          agentId: request.agentId,
          accepted: result.accepted,
          error: null,
        },
      });
      const agent =
        (result.agent as AgentSnapshot | null) ??
        ((await this.bridge.getAgentPayloadById(request.agentId)) as AgentSnapshot | null);
      if (agent) {
        this.sendAgentUpsert(agent);
      }
      this.sendSession({
        type: "xcodex_thread_runtime_update",
        payload: {
          agentId: request.agentId,
          route: result.route,
        },
      });
      void this.forwardWorkspaceUpdate(route.workspaceId);
    } catch (error) {
      this.sendSession({
        type: "set_agent_model_response",
        payload: {
          requestId: request.requestId,
          agentId: request.agentId,
          accepted: false,
          error: getErrorMessage(error),
        },
      });
    }
  }

  private async handleGetProvidersSnapshot(request: ProvidersSnapshotRequest) {
    this.sendSession({
      type: "get_providers_snapshot_response",
      payload: {
        entries: await this.buildProvidersSnapshotEntries(),
        generatedAt: new Date().toISOString(),
        requestId: request.requestId,
      },
    });
  }

  private async handleRefreshProvidersSnapshot(request: RefreshProvidersSnapshotRequest) {
    this.sendSession({
      type: "refresh_providers_snapshot_response",
      payload: {
        requestId: request.requestId,
        acknowledged: true,
      },
    });
    this.sendSession({
      type: "providers_snapshot_update",
      payload: {
        cwd: request.cwd,
        entries: await this.buildProvidersSnapshotEntries(),
        generatedAt: new Date().toISOString(),
      },
    });
  }

  private async handleXcodexRuntimeCatalog(request: XcodexRuntimeCatalogRequest) {
    try {
      const catalog = await this.bridge.runtimeCatalog({
        agentId: request.agentId,
        includeModels: request.includeModels ?? true,
      });
      this.sendSession({
        type: "xcodex_runtime_catalog_response",
        payload: {
          requestId: request.requestId,
          agentId: request.agentId,
          catalog,
          error: null,
        },
      });
    } catch (error) {
      this.sendSession({
        type: "xcodex_runtime_catalog_response",
        payload: {
          requestId: request.requestId,
          agentId: request.agentId,
          catalog: null,
          error: getErrorMessage(error),
        },
      });
    }
  }

  private async handleXcodexThreadRuntimeSet(request: XcodexThreadRuntimeSetRequest) {
    try {
      const result = await this.bridge.setThreadRuntime({
        agentId: request.agentId,
        providerId: request.providerId,
        supplierId: request.supplierId,
        modelId: request.modelId,
        realProviderOverride: request.realProviderOverride,
        expectedUpdatedAtMs: request.expectedUpdatedAtMs,
      });
      this.sendSession({
        type: "xcodex_thread_runtime_set_response",
        payload: {
          requestId: request.requestId,
          agentId: request.agentId,
          accepted: result.accepted,
          route: result.route,
          error: null,
        },
      });
      if (result.agent) {
        this.sendAgentUpsert(result.agent as AgentSnapshot);
      }
      this.sendSession({
        type: "xcodex_thread_runtime_update",
        payload: {
          agentId: request.agentId,
          route: result.route,
        },
      });
      void this.forwardWorkspaceUpdate(result.route.workspaceId);
    } catch (error) {
      this.sendSession({
        type: "xcodex_thread_runtime_set_response",
        payload: {
          requestId: request.requestId,
          agentId: request.agentId,
          accepted: false,
          route: null,
          error: getErrorMessage(error),
        },
      });
    }
  }

  private async buildProvidersSnapshotEntries() {
    const entry = await this.bridge.providersSnapshotEntry();
    if (!entry) {
      return [
        {
          provider: "xcodex",
          status: "error",
          enabled: true,
          label: "xCodex",
          description: "Remote control for xCodex desktop threads",
          models: [],
          fetchedAt: new Date().toISOString(),
          error: "xCodex runtime catalog is unavailable",
        },
      ];
    }
    return [entry];
  }

  private async handleFileExplorer(request: FileExplorerRequest) {
    const requestedPath = request.path ?? ".";
    try {
      const payload = await this.bridge.fileExplorer({
        cwd: request.cwd,
        path: requestedPath,
        mode: request.mode,
        acceptBinary: request.acceptBinary,
      });
      this.sendSession({
        type: "file_explorer_response",
        payload: {
          ...payload,
          requestId: request.requestId,
          error: null,
        },
      });
    } catch (error) {
      this.sendSession({
        type: "file_explorer_response",
        payload: {
          cwd: request.cwd,
          path: requestedPath,
          mode: request.mode,
          directory: null,
          file: null,
          error: getErrorMessage(error),
          requestId: request.requestId,
        },
      });
    }
  }

  private async handleProjectIcon(request: ProjectIconRequest) {
    try {
      const payload = await this.bridge.projectIcon(request.cwd);
      this.sendSession({
        type: "project_icon_response",
        payload: {
          ...payload,
          requestId: request.requestId,
          error: null,
        },
      });
    } catch (error) {
      this.sendSession({
        type: "project_icon_response",
        payload: {
          cwd: request.cwd,
          icon: null,
          error: getErrorMessage(error),
          requestId: request.requestId,
        },
      });
    }
  }

  private handleBridgeEvent(event: XcodexBridgeAppServerEvent) {
    if (!this.active) return;
    const threadId = xcodexThreadIdFromEvent(event);
    if (!threadId) return;
    const agentId = `xcodex:${event.payload.workspaceId}:${threadId}`;
    const streamEvent = this.xcodexStreamEvents.fromAppServer(event);
    if (streamEvent) {
      this.sendSession({
        type: "agent_stream",
        payload: {
          agentId,
          event: streamEvent,
          timestamp: xcodexEventTimestamp(event),
          seq: typeof event.seq === "number" ? event.seq : undefined,
          epoch: agentId,
        },
      });
    }
    if (!this.realtimeStreamingEnabled && !isXcodexTurnLifecycleAppServerEvent(event)) {
      return;
    }
    void this.forwardAgentUpdate(agentId);
    void this.forwardWorkspaceUpdate(event.payload.workspaceId);
  }

  private async forwardAgentUpdate(agentId: string) {
    if (!this.agentSubscription) return;
    const agent = (await this.bridge.getAgentPayloadById(agentId)) as AgentSnapshot | null;
    if (!agent) {
      this.sendSession({ type: "agent_update", payload: { kind: "remove", agentId } });
      return;
    }
    this.sendAgentUpsert(agent);
  }

  private sendAgentUpsert(agent: AgentSnapshot) {
    const project = this.bridge.buildProjectPlacement(agent as never) as ProjectPlacement;
    const payload =
      !this.agentSubscription ||
      matchesAgentFilter(agent, project, this.agentSubscription.request.filter)
        ? { kind: "upsert", agent, project }
        : { kind: "remove", agentId: agent.id };
    this.sendSession({ type: "agent_update", payload });
  }

  private async forwardWorkspaceUpdate(workspaceId: string) {
    if (!this.workspaceSubscription) return;
    const payload = await this.bridge.listWorkspacePayloads(
      this.workspaceSubscription.request as never,
    );
    const workspace = payload.entries.find((entry: { id: string }) => entry.id === workspaceId);
    this.sendSession({
      type: "workspace_update",
      payload: workspace ? { kind: "upsert", workspace } : { kind: "remove", id: workspaceId },
    });
  }
}

async function generatePairingOffer(options: {
  paseoHome: string;
  listen: ListenAddress;
  relayEndpoint: string;
  relayUseTls: boolean;
  appBaseUrl: string;
  logger: LoggerLike;
}) {
  await mkdir(options.paseoHome, { recursive: true });
  const serverId = getOrCreateServerId(options.paseoHome, { logger: options.logger });
  const daemonKeyPair = await loadOrCreateDaemonKeyPair(options.paseoHome, options.logger as never);
  const directTcpEndpoints = buildAdvertisedDirectTcpEndpoints({
    configuredListen: options.listen,
  });
  const offer = await createConnectionOfferV2({
    serverId,
    daemonPublicKeyB64: daemonKeyPair.publicKeyB64,
    relay: { endpoint: options.relayEndpoint, useTls: options.relayUseTls },
    ...(directTcpEndpoints.length > 0
      ? { directTcp: { endpoints: directTcpEndpoints, useTls: false } }
      : {}),
  });
  return {
    relayEnabled: true,
    directTcpEnabled: directTcpEndpoints.length > 0,
    directTcpEndpoints,
    url: encodeOfferToFragmentUrl({ offer, appBaseUrl: options.appBaseUrl }),
    qr: null,
  };
}

async function startConnector(options: ServerOptions) {
  await mkdir(options.paseoHome, { recursive: true });
  await acquirePidLock(options.paseoHome, null);

  const serverId = getOrCreateServerId(options.paseoHome, { logger: options.logger });
  const daemonKeyPair = await loadOrCreateDaemonKeyPair(options.paseoHome, options.logger as never);
  const bridge = createXcodexBridgeClient({ logger: options.logger as never });
  const wsServer = new WebSocketServer({ noServer: true });
  let relay: RelayTransportController | null = null;
  let nextConnectionSeq = 1;
  let lastClientId: string | null = null;
  let lastConnectedAt: string | null = null;
  let lastSeenAt: string | null = null;
  let lastDisconnectedAt: string | null = null;
  const activeClients = new Map<
    string,
    { clientId: string; connectedAt: string; lastSeenAt: string }
  >();

  const clientTracker: MobileClientConnectionTracker = {
    connected(connectionId, clientId) {
      const now = new Date().toISOString();
      activeClients.set(connectionId, { clientId, connectedAt: now, lastSeenAt: now });
      lastClientId = clientId;
      lastConnectedAt = now;
      lastSeenAt = now;
    },
    seen(connectionId) {
      const client = activeClients.get(connectionId);
      if (!client) return;
      const now = new Date().toISOString();
      client.lastSeenAt = now;
      lastClientId = client.clientId;
      lastSeenAt = now;
    },
    disconnected(connectionId) {
      const client = activeClients.get(connectionId);
      if (!client) return;
      activeClients.delete(connectionId);
      lastClientId = client.clientId;
      lastDisconnectedAt = new Date().toISOString();
    },
  };

  function mobileClientStatus() {
    return {
      activeCount: activeClients.size,
      activeClientIds: [...new Set([...activeClients.values()].map((client) => client.clientId))],
      lastClientId,
      lastConnectedAt,
      lastSeenAt,
      lastDisconnectedAt,
    };
  }

  let advertisedDirectTcpEndpoints: string[] = [];

  const server = createServer((request, response) => {
    const pathname = request.url?.split("?")[0] ?? "/";
    if (pathname === "/api/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          ok: true,
          serverId,
          relayEnabled: options.relayEnabled,
          relayEndpoint: options.relayEndpoint,
          relayUseTls: options.relayUseTls,
          directTcpEnabled: advertisedDirectTcpEndpoints.length > 0,
          directTcpEndpoints: advertisedDirectTcpEndpoints,
          version: CONNECTOR_VERSION,
          xcodexConnector: {
            realtimeStreamingEnabled: options.realtimeStreamingEnabled,
            directTcpEndpoints: advertisedDirectTcpEndpoints,
          },
          clients: mobileClientStatus(),
        }),
      );
      return;
    }
    if (pathname === "/api/discovery" || pathname === "/api/xcodex/discovery") {
      const directTcpEndpoints = buildAdvertisedDirectTcpEndpoints({
        configuredListen: options.listen,
        actualListen: formatListenAddress(server.address()),
        requestHost: request.headers.host,
      });
      void (async () => {
        try {
          const offer = await createConnectionOfferV2({
            serverId,
            daemonPublicKeyB64: daemonKeyPair.publicKeyB64,
            relay: { endpoint: options.relayEndpoint, useTls: options.relayUseTls },
            ...(directTcpEndpoints.length > 0
              ? { directTcp: { endpoints: directTcpEndpoints, useTls: false } }
              : {}),
          });
          response.writeHead(200, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              ok: true,
              kind: "xcodex_mobile_connector",
              v: 1,
              serverId,
              hostname: hostname(),
              version: CONNECTOR_VERSION,
              relay: { endpoint: options.relayEndpoint, useTls: options.relayUseTls },
              directTcp: {
                endpoints: directTcpEndpoints,
                useTls: false,
              },
              offer,
              offerUrl: encodeOfferToFragmentUrl({ offer, appBaseUrl: options.appBaseUrl }),
            }),
          );
        } catch (error) {
          response.writeHead(500, { "content-type": "application/json" });
          response.end(JSON.stringify({ ok: false, error: getErrorMessage(error) }));
        }
      })();
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: false, error: "not_found" }));
  });

  const attachSocket = async (socket: SocketLike) => {
    const connectionId = `mobile-${Date.now()}-${nextConnectionSeq++}`;
    const session = new ClientSession(
      connectionId,
      socket,
      bridge,
      serverId,
      options.logger.child({ client: "mobile" }),
      clientTracker,
      options.realtimeStreamingEnabled,
    );
    void session;
  };

  wsServer.on("connection", (socket) => {
    void attachSocket(socket);
  });

  server.on("upgrade", (request: IncomingMessage, socket, head) => {
    if (request.url?.split("?")[0] !== "/ws") {
      socket.destroy();
      return;
    }
    wsServer.handleUpgrade(request, socket, head, (webSocket) => {
      wsServer.emit("connection", webSocket, request);
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.listen.port, options.listen.host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const listen = formatListenAddress(server.address());
  advertisedDirectTcpEndpoints = buildAdvertisedDirectTcpEndpoints({
    configuredListen: options.listen,
    actualListen: listen,
  });
  await updatePidLock(options.paseoHome, { listen });

  if (options.relayEnabled) {
    relay = startRelayTransport({
      logger: options.logger as never,
      attachSocket,
      relayEndpoint: options.relayEndpoint,
      relayUseTls: options.relayUseTls,
      serverId,
      daemonKeyPair: daemonKeyPair.keyPair,
    });
  }

  options.logger.info(
    {
      listen,
      serverId,
      relayEnabled: options.relayEnabled,
      relayEndpoint: options.relayEndpoint,
      realtimeStreamingEnabled: options.realtimeStreamingEnabled,
    },
    "xcodex_mobile_connector_started",
  );

  async function shutdown() {
    options.logger.info({}, "xcodex_mobile_connector_stopping");
    await relay?.stop().catch((error) => options.logger.warn({ err: error }, "relay_stop_failed"));
    await new Promise<void>((resolve) => wsServer.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await releasePidLock(options.paseoHome);
  }

  process.once("SIGINT", () => {
    void shutdown().finally(() => process.exit(0));
  });
  process.once("SIGTERM", () => {
    void shutdown().finally(() => process.exit(0));
  });
}

async function main() {
  const logger = createLogger({ module: "xcodex-mobile-connector" });
  const options = {
    paseoHome: resolvePaseoHome(),
    listen: parseListenAddress(getEnvString("PASEO_LISTEN", "127.0.0.1:6767")),
    relayEnabled: getEnvBoolean("PASEO_RELAY_ENABLED", true),
    relayEndpoint: getEnvString("PASEO_RELAY_ENDPOINT", DEFAULT_RELAY_ENDPOINT),
    relayUseTls: getEnvBoolean("PASEO_RELAY_USE_TLS", true),
    appBaseUrl: getEnvString("PASEO_APP_BASE_URL", DEFAULT_APP_BASE_URL),
    realtimeStreamingEnabled: getEnvBoolean("XCODEX_MOBILE_REALTIME_STREAMING_ENABLED", false),
    logger,
  } satisfies ServerOptions;

  if (process.argv.includes("--print-pairing")) {
    const pairing = await generatePairingOffer({ ...options, logger: createSilentLogger() });
    process.stdout.write(JSON.stringify(pairing));
    return;
  }

  await startConnector(options);
}

main().catch((error) => {
  console.error(getErrorMessage(error));
  process.exit(1);
});
