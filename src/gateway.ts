import type { Router, Request, Response } from "express";
import type { Facilitator } from "./facilitator.js";
import type { SupportedPaymentKind } from "x402/types";

export type GatewayOptions = {
  basePath?: string;
  staticPeers?: string[];
  verifyQuorum?: number; // number of successful verifies required to accept (default 1)
  peerTtlMs?: number; // how long to keep a peer announcement as fresh (default 2 minutes)
  peerMultiaddrs?: string[]; // optional known multiaddrs for direct dialing (maps by trailing /p2p/<peerId>)
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
  const peerIdToMultiaddrs = new Map<string, string[]>();

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

  // Seed known multiaddrs
  for (const maddr of options.peerMultiaddrs ?? []) {
    const match = /\/p2p\/([^/]+)$/i.exec(maddr);
    const pid = match?.[1];
    if (pid) {
      const list = peerIdToMultiaddrs.get(pid) ?? [];
      list.push(maddr);
      peerIdToMultiaddrs.set(pid, list);
    }
  }

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
      const inbound = req.body as any;
      const forwardBody = inbound?.paymentPayload && inbound?.paymentRequirements
        ? inbound
        : inbound?.paymentHeader && inbound?.paymentRequirements
          ? { paymentPayload: { header: inbound.paymentHeader }, paymentRequirements: inbound.paymentRequirements }
          : inbound;

      type Attempt =
        | { kind: "true" }
        | { kind: "false" }
        | { kind: "error"; status: number; body: any }
        | { kind: "fail" };

      const attempts = candidatePeers.map(async (peerId): Promise<Attempt> => {
        try {
          const response = await facilitator.p2p!.requestVerify(peerId, forwardBody, 10_000);
          if (response.status === 200) {
            return response.body === true ? { kind: "true" } : { kind: "false" };
          }
          return { kind: "error", status: response.status, body: response.body };
        } catch {}

        // Fallback: try direct multiaddr if known
        const maddrs = peerIdToMultiaddrs.get(peerId) ?? [];
        for (const m of maddrs) {
          try {
            const response = await facilitator.p2p!.requestVerifyByMultiaddr(m, req.body, 10_000);
            if (response.status === 200) {
              return response.body === true ? { kind: "true" } : { kind: "false" };
            }
            return { kind: "error", status: response.status, body: response.body };
          } catch {}
        }
        return { kind: "fail" };
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

      if (trueCount >= verifyQuorum) return res.status(200).json({ isValid: true, invalidReason: null });
      if (sawFalse) return res.status(200).json({ isValid: false, invalidReason: null });
      if (firstError) {
        const reason = typeof firstError.body?.error === "string" ? firstError.body.error : undefined;
        return res.status(400).json({ isValid: false, invalidReason: reason ?? "Verification error" });
      }
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
      const inbound = req.body as any;
      const forwardBody = inbound?.paymentPayload && inbound?.paymentRequirements
        ? inbound
        : inbound?.paymentHeader && inbound?.paymentRequirements
          ? { paymentPayload: { header: inbound.paymentHeader }, paymentRequirements: inbound.paymentRequirements }
          : inbound;
      try {
        const response = await facilitator.p2p!.requestSettle(peerId, forwardBody, 30_000);
        if (response.status === 200) {
          const txHash = (response.body as any)?.txHash ?? null;
          return res.status(200).json({ success: true, error: null, txHash, networkId: null });
        }
        const errMsg = (response.body as any)?.error ?? "Settle error";
        return res.status(400).json({ success: false, error: errMsg, txHash: null, networkId: null });
      } catch {}
      const maddrs = peerIdToMultiaddrs.get(peerId) ?? [];
      for (const m of maddrs) {
        try {
          const response = await facilitator.p2p!.requestSettleByMultiaddr(m, forwardBody, 30_000);
          if (response.status === 200) {
            const txHash = (response.body as any)?.txHash ?? null;
            return res.status(200).json({ success: true, error: null, txHash, networkId: null });
          }
          const errMsg = (response.body as any)?.error ?? "Settle error";
          return res.status(400).json({ success: false, error: errMsg, txHash: null, networkId: null });
        } catch {}
      }
      return res.status(503).json({ success: false, error: "Settle unavailable", txHash: null, networkId: null });
    } catch (err: any) {
      return res.status(502).json({ error: "Settle failed", message: err?.message });
    }
  });
}


