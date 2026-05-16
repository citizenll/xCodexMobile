import { ConnectionOfferSchema, type ConnectionOffer } from "@server/shared/connection-offer";

const DEFAULT_XCODEX_LAN_PORT = 6767;
const DEFAULT_TIMEOUT_MS = 450;
const DEFAULT_CONCURRENCY = 48;
const DEFAULT_MAX_RESULTS = 5;
const DISCOVERY_PATHS = ["/api/xcodex/discovery", "/api/discovery"] as const;
const FALLBACK_PREFIXES = ["192.168.31", "192.168.1", "192.168.0", "10.0.0"] as const;

export interface LanDiscoveryResult {
  endpoint: string;
  offer: ConnectionOffer;
  hostname: string | null;
  offerUrl: string | null;
}

interface DiscoverLanHostsOptions {
  port?: number;
  timeoutMs?: number;
  concurrency?: number;
  maxResults?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIpv4Address(value: string | null | undefined): value is string {
  if (!value) return false;
  const parts = value.split(".");
  return (
    parts.length === 4 &&
    parts.every((part) => {
      if (!/^\d+$/.test(part)) return false;
      const octet = Number(part);
      return Number.isInteger(octet) && octet >= 0 && octet <= 255;
    })
  );
}

function ipv4Prefix(value: string): string | null {
  if (!isIpv4Address(value)) return null;
  return value.split(".").slice(0, 3).join(".");
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

export function buildLanDiscoveryEndpoints(input: {
  localIp?: string | null;
  port?: number;
}): string[] {
  const port = input.port ?? DEFAULT_XCODEX_LAN_PORT;
  const prefixes = dedupePreserveOrder([
    ...(input.localIp ? [ipv4Prefix(input.localIp)].filter((v): v is string => Boolean(v)) : []),
    ...FALLBACK_PREFIXES,
  ]);
  const ownIp = input.localIp?.trim() ?? null;
  const endpoints: string[] = [];
  for (const prefix of prefixes) {
    for (let host = 1; host <= 254; host += 1) {
      const ip = `${prefix}.${host}`;
      if (ip === ownIp) continue;
      endpoints.push(`${ip}:${port}`);
    }
  }
  return dedupePreserveOrder(endpoints);
}

async function resolveLocalIpAddress(): Promise<string | null> {
  try {
    const Network = await import("expo-network");
    const ip = await Network.getIpAddressAsync();
    return isIpv4Address(ip) ? ip : null;
  } catch {
    return null;
  }
}

async function fetchJsonWithTimeout(url: string, timeoutMs: number): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "GET",
      signal: controller.signal,
      headers: {
        accept: "application/json",
      },
    });
    if (!response.ok) {
      return null;
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

function parseDiscoveryPayload(payload: unknown, endpoint: string): LanDiscoveryResult | null {
  if (!isRecord(payload)) return null;
  if (payload.kind !== "xcodex_mobile_connector") return null;
  const offer = ConnectionOfferSchema.safeParse(payload.offer);
  if (!offer.success) return null;
  return {
    endpoint,
    offer: offer.data,
    hostname:
      typeof payload.hostname === "string" && payload.hostname.trim() ? payload.hostname : null,
    offerUrl:
      typeof payload.offerUrl === "string" && payload.offerUrl.trim() ? payload.offerUrl : null,
  };
}

async function probeEndpoint(
  endpoint: string,
  timeoutMs: number,
): Promise<LanDiscoveryResult | null> {
  for (const path of DISCOVERY_PATHS) {
    try {
      const payload = await fetchJsonWithTimeout(`http://${endpoint}${path}`, timeoutMs);
      const result = parseDiscoveryPayload(payload, endpoint);
      if (result) return result;
    } catch {
      // Most addresses in a subnet will not run xCodex.
    }
  }
  return null;
}

export async function discoverXcodexLanHosts(
  options: DiscoverLanHostsOptions = {},
): Promise<LanDiscoveryResult[]> {
  const port = options.port ?? DEFAULT_XCODEX_LAN_PORT;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY);
  const maxResults = Math.max(1, options.maxResults ?? DEFAULT_MAX_RESULTS);
  const localIp = await resolveLocalIpAddress();
  const endpoints = buildLanDiscoveryEndpoints({ localIp, port });
  const results: LanDiscoveryResult[] = [];
  const seenServerIds = new Set<string>();
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (results.length < maxResults) {
      const index = nextIndex;
      nextIndex += 1;
      const endpoint = endpoints[index];
      if (!endpoint) return;
      const result = await probeEndpoint(endpoint, timeoutMs);
      if (!result || seenServerIds.has(result.offer.serverId)) {
        continue;
      }
      seenServerIds.add(result.offer.serverId);
      results.push(result);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, endpoints.length) }, () => worker()),
  );
  return results;
}
