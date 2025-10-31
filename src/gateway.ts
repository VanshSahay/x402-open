import type { Router, Request, Response } from "express";
import type { Facilitator } from "./facilitator.js";
import type { SupportedPaymentKind } from "x402/types";

export type GatewayOptions = {
  basePath?: string;
  staticPeers?: string[];
  verifyQuorum?: number; // number of successful verifies required to accept (default 1)
  peerTtlMs?: number; // how long to keep a peer announcement as fresh (default 2 minutes)
};

type PeerRecord = {
  peerId: string;
  kinds: SupportedPaymentKind[];
  lastSeenMs: number;
};

/**
 * Mounts a single-RPC gateway that forwards requests to multiple peers over libp2p.
 * Exposes:
 *   - POST <basePath>/rpc/verify  (fan-out to peers, accept first-success or quorum)
 *   - POST <basePath>/rpc/settle  (forward to one randomly selected peer)
 */
export function createGatewayAdapter(
  facilitator: Facilitator,
  router: Router,
  options: GatewayOptions = {}
): void {
  const basePath = options.basePath ?? "";
  const verifyQuorum = Math.max(1, options.verifyQuorum ?? 1);
  const peerTtlMs = options.peerTtlMs ?? 2 * 60_000;

  const peerIdToRecord = new Map<string, PeerRecord>();

  // Seed static peers (no known kinds yet)
  for (const peerId of options.staticPeers ?? []) {
    peerIdToRecord.set(peerId, { peerId, kinds: [], lastSeenMs: 0 });
  }

  // Track peers via announcements when available
  facilitator.p2p?.onAnnouncement((peerId, kinds) => {
    const now = Date.now();
    const existing = peerIdToRecord.get(peerId);
    if (existing) {
      peerIdToRecord.set(peerId, { peerId, kinds, lastSeenMs: now });
    } else {
      peerIdToRecord.set(peerId, { peerId, kinds, lastSeenMs: now });
    }
  });

  function normalizePath(path: string): string {
    const p = basePath + path;
    return p || "/";
  }

  function getActivePeers(): string[] {
    const now = Date.now();
    const peers: string[] = [];
    for (const rec of peerIdToRecord.values()) {
      if (now - rec.lastSeenMs <= peerTtlMs || rec.lastSeenMs === 0) {
        peers.push(rec.peerId);
      }
    }
    return peers;
  }

  function pickRandom<T>(arr: T[]): T {
    return arr[Math.floor(Math.random() * arr.length)];
  }

  // POST /rpc/verify
  router.post(normalizePath("/rpc/verify"), async (req: Request, res: Response) => {
    const peers = getActivePeers();
    if (!facilitator.p2p || peers.length === 0) {
      return res.status(503).json({ error: "No peers available" });
    }

    // Optional filter by requested network when available
    let candidatePeers = peers;
    try {
      const requestedNetwork = (req.body?.paymentRequirements?.network ?? undefined) as string | undefined;
      if (requestedNetwork) {
        candidatePeers = peers.filter((peerId) => {
          const rec = peerIdToRecord.get(peerId);
          if (!rec || !Array.isArray(rec.kinds)) return true; // if unknown, keep
          return rec.kinds.some((k) => (k as any)?.network === requestedNetwork);
        });
        if (candidatePeers.length === 0) candidatePeers = peers;
      }
    } catch {}

    try {
      type Attempt =
        | { kind: "true" }
        | { kind: "false" }
        | { kind: "error"; status: number; body: any }
        | { kind: "fail" };

      const attempts = candidatePeers.map(async (peerId): Promise<Attempt> => {
        try {
          const response = await facilitator.p2p!.requestVerify(peerId, req.body, 10_000);
          if (response.status === 200) {
            return response.body === true ? { kind: "true" } : { kind: "false" };
          }
          return { kind: "error", status: response.status, body: response.body };
        } catch (e) {
          return { kind: "fail" };
        }
      });

      const results = await Promise.allSettled(attempts);
      let trueCount = 0;
      let sawFalse = false;
      let firstError: { status: number; body: any } | undefined;

      for (const r of results) {
        if (r.status !== "fulfilled") continue;
        const v = r.value;
        if (v.kind === "true") trueCount += 1;
        else if (v.kind === "false") sawFalse = true;
        else if (v.kind === "error" && !firstError) firstError = { status: v.status, body: v.body };
      }

      if (trueCount >= verifyQuorum) return res.status(200).json(true);
      if (sawFalse) return res.status(200).json(false);
      if (firstError) return res.status(firstError.status).json(firstError.body);
      return res.status(503).json({ error: "Verification unavailable" });
    } catch (err: any) {
      return res.status(500).json({ error: "Internal error", message: err?.message });
    }
  });

  // POST /rpc/settle
  router.post(normalizePath("/rpc/settle"), async (req: Request, res: Response) => {
    const peers = getActivePeers();
    if (!facilitator.p2p || peers.length === 0) {
      return res.status(503).json({ error: "No peers available" });
    }
    const peerId = pickRandom(peers);
    try {
      const response = await facilitator.p2p!.requestSettle(peerId, req.body, 30_000);
      return res.status(response.status).json(response.body);
    } catch (err: any) {
      return res.status(502).json({ error: "Settle failed", message: err?.message });
    }
  });
}


