import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import {
  type GatewayOptions,
  aggregateSupportedKinds,
  handleGatewayVerify,
  handleGatewaySettle,
  handleGatewayRegister,
  StickyRouter,
  PeerRegistry,
} from "../gateway/core.js";

export type HonoGatewayOptions = GatewayOptions;

/**
 * Creates a Hono app that acts as an HTTP gateway, routing verify/settle
 * requests across multiple facilitator nodes with sticky routing.
 *
 * Mount with `parentApp.route("/facilitator", createHonoGatewayAdapter(opts))`.
 *
 * Routes exposed (relative to mount point):
 *   GET  /supported   — aggregated kinds from all peers
 *   POST /verify      — random node, sticky selection recorded
 *   POST /settle      — sticky node from verify, fallback to others
 *   POST /register    — node self-registration
 *   GET  /peers       — diagnostic: list active peers
 */
export function createHonoGatewayAdapter(options: HonoGatewayOptions): Hono {
  const app = new Hono();
  const sticky = new StickyRouter();
  const registry = new PeerRegistry();
  const logPrefix = "[hono-gateway]";

  function peers(): string[] {
    return registry.getActivePeers(options.httpPeers ?? []);
  }

  // GET /supported — aggregate from peers
  app.get("/supported", async (c) => {
    const kinds = await aggregateSupportedKinds(peers());
    return c.json({ kinds });
  });

  // POST /verify — single randomly selected node (stick to this node by payer/header)
  app.post("/verify", async (c) => {
    const inbound = await c.req.json();
    const r = await handleGatewayVerify({ peers: peers(), inbound, sticky, debug: options.debug, logPrefix });
    return c.json(r.body, r.status as ContentfulStatusCode);
  });

  // POST /settle — use the same selected node (sticky by payer/header); fallback to others on failure
  app.post("/settle", async (c) => {
    const inbound = await c.req.json();
    const r = await handleGatewaySettle({ peers: peers(), inbound, sticky, debug: options.debug, logPrefix });
    return c.json(r.body, r.status as ContentfulStatusCode);
  });

  // POST /register — nodes can self-register with the gateway
  app.post("/register", async (c) => {
    const inbound = await c.req.json().catch(() => undefined);
    const r = handleGatewayRegister(registry, inbound);
    return c.json(r.body, r.status as ContentfulStatusCode);
  });

  // GET /peers — diagnostic endpoint
  app.get("/peers", (c) => {
    return c.json({ peers: peers() });
  });

  return app;
}
