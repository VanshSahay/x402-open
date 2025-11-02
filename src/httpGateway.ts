import type { Router, Request, Response } from "express";

export type HttpGatewayOptions = {
  basePath?: string;
  httpPeers: string[]; // e.g. ["http://localhost:4101/facilitator", "http://localhost:4102/facilitator"]
  verifyQuorum?: number; // default 1
  timeoutMs?: number; // default 10s verify, 30s settle
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

  // POST /rpc/verify — fan out to HTTP peers
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
        if (v.kind === "true") trueCount += 1;
        else if (v.kind === "false") sawFalse = true;
        else if (v.kind === "error" && !firstError) firstError = { status: v.status, body: v.body };
      }

      if (trueCount >= verifyQuorum) return res.status(200).json({ isValid: true, invalidReason: null });
      if (sawFalse) return res.status(200).json({ isValid: false, invalidReason: null });
      if (firstError) {
        const reason = typeof firstError.body?.error === "string" ? firstError.body.error : undefined;
        return res.status(200).json({ isValid: false, invalidReason: reason ?? "Verification error" });
      }
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

    const peer = pickRandom(peers);
    try {
      const url = peer.replace(/\/$/, "") + "/settle";
      const response = await postJson(url, forwardBody, settleTimeout);
      if (response.status === 200) {
        const txHash = (response.body as any)?.txHash ?? null;
        return res.status(200).json({ success: true, error: null, txHash, networkId: null });
      }
      const errMsg = (response.body as any)?.error ?? "Settle error";
      return res.status(200).json({ success: false, error: errMsg, txHash: null, networkId: null });
    } catch (err: any) {
      return res.status(503).json({ success: false, error: "Settle unavailable", txHash: null, networkId: null });
    }
  });
}


