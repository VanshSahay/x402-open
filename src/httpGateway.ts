import type { Router, Request, Response } from "express";

export type HttpGatewayOptions = {
  basePath?: string;
  httpPeers: string[]; // e.g. ["http://localhost:4101/facilitator", "http://localhost:4102/facilitator"]
  debug?: boolean;
};

async function postJson(url: string, body: unknown, timeoutMs: number): Promise<{ status: number; body: any }> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    } as any);
    const text = await res.text();
    let parsed: any;
    try { parsed = text ? JSON.parse(text) : undefined; } catch { parsed = text; }
    return { status: res.status, body: parsed };
  } finally {
    clearTimeout(t);
  }
}

export function createHttpGatewayAdapter(router: Router, options: HttpGatewayOptions): void {
  const basePath = options.basePath ?? "";
  const verifyTimeout = 10_000;
  const settleTimeout = 30_000;
  const selectionTtlMs = 5 * 60_000; // keep selection for 5 minutes by default

  function normalizePath(path: string): string {
    const p = basePath + path;
    return p || "/";
  }

  function pickRandom<T>(arr: T[]): T {
    return arr[Math.floor(Math.random() * arr.length)];
  }

  function getHeaderFromBody(body: any): string | undefined {
    return body?.paymentHeader ?? body?.paymentPayload?.header;
  }

  const selectionByHeader = new Map<string, { peer: string; expiresAt: number }>();

  // Select a random peer. We will persist the chosen peer AFTER a successful verify
  // so that subsequent settle for the same header uses the same node.
  function pickSelectedPeerForVerify(peers: string[]): string {
    if (peers.length === 1) return peers[0];
    return pickRandom(peers);
  }

  function rotateToNext(peers: string[], current: string): string[] {
    if (peers.length <= 1) return peers.slice();
    const rest = peers.filter((p) => p !== current).sort(() => Math.random() - 0.5);
    return [current, ...rest];
  }

  // GET /supported — aggregate from peers
  router.get(normalizePath("/supported"), async (_req: Request, res: Response) => {
    const peers = options.httpPeers;
    if (!peers || peers.length === 0) return res.status(200).json({ kinds: [] });
    const results = await Promise.allSettled(peers.map(async (base) => {
      try {
        const url = base.replace(/\/$/, "") + "/supported";
        const r = await fetch(url);
        const j = await r.json();
        return Array.isArray(j?.kinds) ? j.kinds : [];
      } catch {
        return [] as any[];
      }
    }));
    const kinds: any[] = [];
    for (const r of results) if (r.status === "fulfilled") kinds.push(...r.value);
    const seen = new Set<string>();
    const uniq = kinds.filter((k) => {
      const key = JSON.stringify(k);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    return res.status(200).json({ kinds: uniq });
  });

  // POST /verify — single randomly selected node (sticky per payment header)
  router.post(normalizePath("/verify"), async (req: Request, res: Response) => {
    const peers = options.httpPeers;
    if (!peers || peers.length === 0) return res.status(503).json({ error: "No peers configured" });

    // Accept both spec and internal body shapes
    const inbound = req.body as any;
    const forwardBody = inbound?.paymentPayload && inbound?.paymentRequirements
      ? inbound
      : inbound?.paymentHeader && inbound?.paymentRequirements
        ? { paymentPayload: { header: inbound.paymentHeader }, paymentRequirements: inbound.paymentRequirements }
        : inbound;

    try {
      const primary = pickSelectedPeerForVerify(peers);
      const order = rotateToNext(peers, primary);
      let lastError: { status: number; body: any } | undefined;
      for (const base of order) {
        const url = base.replace(/\/$/, "") + "/verify";
        try {
          if (options.debug) console.log("[http-gateway] verify via", url);
          const response = await postJson(url, forwardBody, verifyTimeout);
          if (response.status === 200) {
            // Store sticky selection for future settle
            const key = getHeaderFromBody(forwardBody);
            if (key) selectionByHeader.set(key, { peer: base, expiresAt: Date.now() + selectionTtlMs });
            return res.status(200).json(response.body);
          }
          if (options.debug) console.log("[http-gateway] verify non-200 from", url, response.status, response.body);
          lastError = { status: response.status, body: response.body };
        } catch (e: any) {
          if (options.debug) console.log("[http-gateway] verify network error from", url, e?.message);
        }
      }
      if (lastError) return res.status(lastError.status).json(lastError.body);
      return res.status(503).json({ error: "Verification unavailable" });
    } catch (err: any) {
      return res.status(500).json({ error: "Internal error", message: err?.message });
    }
  });


  // POST /settle — use the same selected node (sticky by header); fallback to others on failure
  router.post(normalizePath("/settle"), async (req: Request, res: Response) => {
    const peers = options.httpPeers;
    if (!peers || peers.length === 0) return res.status(503).json({ success: false, error: "No peers configured", txHash: null, networkId: null });
    const inbound = req.body as any;
    const forwardBody = inbound?.paymentPayload && inbound?.paymentRequirements
      ? inbound
      : inbound?.paymentHeader && inbound?.paymentRequirements
        ? { paymentPayload: { header: inbound.paymentHeader }, paymentRequirements: inbound.paymentRequirements }
        : inbound;
    // Use sticky selection first, then try others
    const key = getHeaderFromBody(forwardBody);
    const preferred = key && selectionByHeader.get(key)?.peer ? selectionByHeader.get(key)!.peer : pickSelectedPeerForVerify(peers);
    const order = rotateToNext(peers, preferred);
    for (const peer of order) {
      const url = peer.replace(/\/$/, "") + "/settle";
      try {
        if (options.debug) console.log("[http-gateway] settling via", url);
        const response = await postJson(url, forwardBody, settleTimeout);
        if (response.status === 200) return res.status(200).json(response.body);
        if (options.debug) console.log("[http-gateway] settle non-200 from", url, response.status, response.body);
        // try next peer
      } catch (err: any) {
        if (options.debug) console.log("[http-gateway] settle network error from", url, err?.message);
        // try next peer
      }
    }
    return res.status(503).json({ success: false, error: "Settle unavailable", txHash: null, networkId: null });
  });

}


