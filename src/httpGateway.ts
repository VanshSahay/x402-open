import type { Router, Request, Response } from "express";
import {
  type GatewayOptions,
  aggregateSupportedKinds,
  handleGatewayVerify,
  handleGatewaySettle,
  handleGatewayRegister,
  StickyRouter,
  PeerRegistry,
} from "./gateway/core.js";

export type HttpGatewayOptions = GatewayOptions;

export function createHttpGatewayAdapter(router: Router, options: HttpGatewayOptions): void {
  const basePath = options.basePath ?? "";
  const sticky = new StickyRouter();
  const registry = new PeerRegistry();
  const logPrefix = "[http-gateway]";

  function normalizePath(path: string): string {
    const p = basePath + path;
    return p || "/";
  }

  function peers(): string[] {
    return registry.getActivePeers(options.httpPeers ?? []);
  }

  // GET /supported — aggregate from peers
  router.get(normalizePath("/supported"), async (_req: Request, res: Response) => {
    const kinds = await aggregateSupportedKinds(peers());
    return res.status(200).json({ kinds });
  });

  // POST /verify — single randomly selected node (stick to this node by payer/header)
  router.post(normalizePath("/verify"), async (req: Request, res: Response) => {
    const r = await handleGatewayVerify({ peers: peers(), inbound: req.body, sticky, debug: options.debug, logPrefix });
    return res.status(r.status).json(r.body);
  });

  // POST /settle — use the same selected node (sticky by payer/header); fallback to others on failure
  router.post(normalizePath("/settle"), async (req: Request, res: Response) => {
    const r = await handleGatewaySettle({ peers: peers(), inbound: req.body, sticky, debug: options.debug, logPrefix });
    return res.status(r.status).json(r.body);
  });

  // POST /register — nodes can self-register with the gateway
  router.post(normalizePath("/register"), async (req: Request, res: Response) => {
    const r = handleGatewayRegister(registry, req.body);
    return res.status(r.status).json(r.body);
  });

  // Optional: expose current active peers for external load balancers/diagnostics
  router.get(normalizePath("/peers"), (_req: Request, res: Response) => {
    return res.status(200).json({ peers: peers() });
  });
}
