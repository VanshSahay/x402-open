export type NodeRegistrarOptions = {
  gatewayUrls: string[];
  nodeBaseUrl: string; // e.g. http://localhost:4101/facilitator
  intervalMs?: number; // default 30s
  kindsProvider?: () => Promise<any[]>; // optional
  debug?: boolean;
};

/**
 * Starts periodic registration heartbeats to one or more gateways.
 */
export function startGatewayRegistration(opts: NodeRegistrarOptions): () => void {
  const interval = Math.max(5_000, opts.intervalMs ?? 30_000);
  let stopped = false;

  async function heartbeat() {
    if (stopped) return;
    const kinds = opts.kindsProvider ? await safeKinds(opts.kindsProvider) : undefined;
    const body = JSON.stringify({ url: opts.nodeBaseUrl.replace(/\/$/, ""), kinds });
    for (const gw of opts.gatewayUrls) {
      const url = gw.replace(/\/$/, "") + "/register";
      try {
        const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body });
        if (opts.debug) console.log("[registrar]", url, res.status);
      } catch (e: any) {
        if (opts.debug) console.log("[registrar] failed", url, e?.message);
      }
    }
  }

  const timer = setInterval(heartbeat, interval);
  // fire immediately
  heartbeat().catch(() => undefined);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

async function safeKinds(fn: () => Promise<any[]>) {
  try {
    const v = await fn();
    return Array.isArray(v) ? v : undefined;
  } catch {
    return undefined;
  }
}


