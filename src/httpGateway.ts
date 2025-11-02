import type { Router, Request, Response } from "express";

export type HttpGatewayOptions = {
  basePath?: string;
  httpPeers: string[]; // e.g. ["http://localhost:4101/facilitator", "http://localhost:4102/facilitator"]
  verifyQuorum?: number; // default 1
  timeoutMs?: number; // default 10s verify, 30s settle
  debug?: boolean;
  verifyMode?: "fanout" | "single"; // default fanout
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
  const verifyQuorum = Math.max(1, options.verifyQuorum ?? 1);
  const verifyTimeout = options.timeoutMs ?? 10_000;
  const settleTimeout = Math.max(verifyTimeout, 30_000);

  function normalizePath(path: string): string {
    const p = basePath + path;
    return p || "/";
  }

  function pickRandom<T>(arr: T[]): T {
    return arr[Math.floor(Math.random() * arr.length)];
  }

  // POST /rpc/verify — fan out or single-peer mode
  router.post(normalizePath("/rpc/verify"), async (req: Request, res: Response) => {
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
      // Single-peer mode: pick one peer (with fallback) instead of fanning out
      if (options.verifyMode === "single") {
        const shuffled = [...peers].sort(() => Math.random() - 0.5);
        let lastError: { status: number; body: any } | undefined;
        for (const base of shuffled) {
          const url = base.replace(/\/$/, "") + "/verify";
          try {
            if (options.debug) console.log("[http-gateway] verify via", url);
            const response = await postJson(url, forwardBody, verifyTimeout);
            if (response.status === 200) return res.status(200).json(response.body === true);
            if (options.debug) console.log("[http-gateway] verify non-200 from", url, response.status, response.body);
            lastError = { status: response.status, body: response.body };
            // try next peer
          } catch (e: any) {
            if (options.debug) console.log("[http-gateway] verify network error from", url, e?.message);
            // try next peer
          }
        }
        if (lastError) return res.status(400).json(lastError.body);
        return res.status(503).json({ error: "Verification unavailable" });
      }

      // Fan-out mode (default)
      type Attempt =
        | { kind: "true" }
        | { kind: "false" }
        | { kind: "error"; status: number; body: any }
        | { kind: "fail" };

      const attempts = peers.map(async (base) => {
        try {
          const url = base.replace(/\/$/, "") + "/verify";
          const response = await postJson(url, forwardBody, verifyTimeout);
          if (response.status === 200) return response.body === true ? { kind: "true" } : { kind: "false" };
          return { kind: "error", status: response.status, body: response.body };
        } catch {
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
        if (v.kind === "true") {
          trueCount += 1;
        } else if (v.kind === "false") {
          sawFalse = true;
        } else if (v.kind === "error" && !firstError) {
          // Note: fix variable shadowing issue here
          firstError = { status: v.status as number, body: v.body };
        }
      }

      if (typeof trueCount === "number" && trueCount >= verifyQuorum) return res.status(200).json(true);
      if (sawFalse) return res.status(200).json(false);
      if (firstError) return res.status(400).json(firstError.body);
      return res.status(503).json({ error: "Verification unavailable" });
    } catch (err: any) {
      return res.status(500).json({ error: "Internal error", message: err?.message });
    }
  });

  // POST /rpc/settle — pick one peer and forward
  router.post(normalizePath("/rpc/settle"), async (req: Request, res: Response) => {
    const peers = options.httpPeers;
    if (!peers || peers.length === 0) return res.status(503).json({ success: false, error: "No peers configured", txHash: null, networkId: null });
    const inbound = req.body as any;
    const forwardBody = inbound?.paymentPayload && inbound?.paymentRequirements
      ? inbound
      : inbound?.paymentHeader && inbound?.paymentRequirements
        ? { paymentPayload: { header: inbound.paymentHeader }, paymentRequirements: inbound.paymentRequirements }
        : inbound;
    // Try peers in random order until one returns 200 or all fail
    const shuffled = [...peers].sort(() => Math.random() - 0.5);
    for (const peer of shuffled) {
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


