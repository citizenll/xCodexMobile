import os, { type NetworkInterfaceInfo } from "node:os";

import { ConnectionOfferV2Schema, type ConnectionOffer } from "../shared/connection-offer.js";

interface BuildOfferEndpointsArgs {
  listenHost: string;
  port: number;
}

export function buildOfferEndpoints({ listenHost, port }: BuildOfferEndpointsArgs): string[] {
  const endpoints: string[] = [];

  const isLoopbackHost = listenHost === "127.0.0.1" || listenHost === "localhost";
  const isWildcardHost = listenHost === "0.0.0.0" || listenHost === "::" || listenHost === "[::]";

  if (isWildcardHost) {
    endpoints.push(...getLanIps().map((address) => `${address}:${port}`));
  } else if (!isLoopbackHost) {
    endpoints.push(`${listenHost}:${port}`);
  }

  endpoints.push(`localhost:${port}`);

  return dedupePreserveOrder(endpoints);
}

export async function createConnectionOfferV2(args: {
  serverId: string;
  daemonPublicKeyB64: string;
  relay: { endpoint: string; useTls?: boolean };
  directTcp?: { endpoints: string[]; useTls?: boolean };
}): Promise<ConnectionOffer> {
  return ConnectionOfferV2Schema.parse({
    v: 2,
    serverId: args.serverId,
    daemonPublicKeyB64: args.daemonPublicKeyB64,
    relay: args.relay,
    ...(args.directTcp ? { directTcp: args.directTcp } : {}),
  });
}

export function encodeOfferToFragmentUrl(args: {
  offer: ConnectionOffer;
  appBaseUrl: string;
}): string {
  const json = JSON.stringify(args.offer);
  const encoded = Buffer.from(json, "utf8").toString("base64url");
  return `${args.appBaseUrl.replace(/\/$/, "")}/#offer=${encoded}`;
}

function getLanIps(): string[] {
  const override = process.env.PASEO_PRIMARY_LAN_IP?.trim();
  if (override) return [override];

  return selectLanIps(os.networkInterfaces());
}

export function selectPrimaryLanIp(nets: NodeJS.Dict<NetworkInterfaceInfo[]>): string | null {
  return selectLanIps(nets)[0] ?? null;
}

export function selectLanIps(nets: NodeJS.Dict<NetworkInterfaceInfo[]>): string[] {
  const candidates: Array<{
    address: string;
    interfaceName: string;
    interfaceScore: number;
    addressScore: number;
    index: number;
  }> = [];
  const names = Object.keys(nets).sort();
  let index = 0;
  for (const name of names) {
    const addrs = nets[name] ?? [];
    for (const addr of addrs) {
      if (addr.family === "IPv4" && !addr.internal && !isIpv4LinkLocal(addr.address)) {
        candidates.push({
          address: addr.address,
          interfaceName: name,
          interfaceScore: scoreInterfaceName(name),
          addressScore: scoreIpv4Address(addr.address),
          index,
        });
        index += 1;
      }
    }
  }

  candidates.sort(
    (a, b) =>
      a.interfaceScore - b.interfaceScore ||
      a.addressScore - b.addressScore ||
      a.interfaceName.localeCompare(b.interfaceName) ||
      a.index - b.index,
  );
  return dedupePreserveOrder(candidates.map((candidate) => candidate.address));
}

function scoreInterfaceName(name: string): number {
  const normalized = name.toLowerCase();
  const virtualHints = [
    "docker",
    "hyper-v",
    "loopback",
    "tap",
    "tun",
    "virtual",
    "virtualbox",
    "vmnet",
    "vmware",
    "vpn",
    "wsl",
    "zerotier",
  ];
  return virtualHints.some((hint) => normalized.includes(hint)) ? 50 : 0;
}

function scoreIpv4Address(address: string): number {
  const [a, b, c] = address.split(".").map((part) => Number(part));
  if (a === 192 && b === 168 && c === 31) return 0;
  if (a === 192 && b === 168) return 1;
  if (a === 10) return 2;
  if (a === 172 && b >= 16 && b <= 31) return 3;
  return isPrivateIpv4(address) ? 4 : 10;
}

function isPrivateIpv4(address: string): boolean {
  const parts = address.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) return false;
  const [a, b] = parts;
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

function isIpv4LinkLocal(address: string): boolean {
  const [a, b] = address.split(".").map((part) => Number(part));
  return a === 169 && b === 254;
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
