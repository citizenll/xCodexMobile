import type { Logger } from "pino";

import { createConnectionOfferV2, encodeOfferToFragmentUrl } from "./connection-offer.js";
import { loadOrCreateDaemonKeyPair } from "./daemon-keypair.js";
import { renderPairingQr } from "./pairing-qr.js";
import { getOrCreateServerId } from "./server-id.js";
import { shouldUseTlsForDefaultHostedRelay } from "../shared/daemon-endpoints.js";
import { DEFAULT_APP_BASE_URL, DEFAULT_RELAY_ENDPOINT } from "../shared/product-defaults.js";

export interface LocalPairingOffer {
  relayEnabled: boolean;
  url: string | null;
  qr: string | null;
}

export async function generateLocalPairingOffer(args: {
  paseoHome: string;
  relayEnabled?: boolean;
  relayEndpoint?: string;
  relayPublicEndpoint?: string;
  relayUseTls?: boolean;
  appBaseUrl?: string;
  includeQr?: boolean;
  logger?: Logger;
}): Promise<LocalPairingOffer> {
  const relayEnabled = args.relayEnabled ?? true;
  if (!relayEnabled) {
    return {
      relayEnabled: false,
      url: null,
      qr: null,
    };
  }

  const relayEndpoint = args.relayEndpoint ?? DEFAULT_RELAY_ENDPOINT;
  const relayPublicEndpoint = args.relayPublicEndpoint ?? relayEndpoint;
  const relayUseTls = args.relayUseTls ?? shouldUseTlsForDefaultHostedRelay(relayEndpoint);
  const appBaseUrl = args.appBaseUrl ?? DEFAULT_APP_BASE_URL;
  const serverId = getOrCreateServerId(args.paseoHome, { logger: args.logger });
  const daemonKeyPair = await loadOrCreateDaemonKeyPair(args.paseoHome, args.logger);
  const offer = await createConnectionOfferV2({
    serverId,
    daemonPublicKeyB64: daemonKeyPair.publicKeyB64,
    relay: { endpoint: relayPublicEndpoint, useTls: relayUseTls },
  });
  const url = encodeOfferToFragmentUrl({ offer, appBaseUrl });

  if (args.includeQr === false) {
    return {
      relayEnabled: true,
      url,
      qr: null,
    };
  }

  let qr: string | null = null;
  try {
    qr = await renderPairingQr(url);
  } catch (error) {
    args.logger?.debug({ error }, "Failed to render pairing QR");
  }

  return {
    relayEnabled: true,
    url,
    qr,
  };
}
