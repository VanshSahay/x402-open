import { Hono } from "hono";
import type { Facilitator } from "../facilitator.js";
import { formatError } from "./shared/errorHandler.js";

/**
 * Creates a Hono app wired to the given Facilitator.
 * Mount it with `parentApp.route("/facilitator", createHonoAdapter(facilitator))`.
 *
 * Routes exposed (relative to mount point):
 *   GET  /supported
 *   POST /verify
 *   POST /settle
 */
export function createHonoAdapter(facilitator: Facilitator): Hono {
  const app = new Hono();

  app.get("/supported", async (c) => {
    try {
      const response = await facilitator.handleRequest({ method: "GET", path: "/supported" });
      return c.json(response.body, response.status as any);
    } catch (error) {
      return c.json(formatError(error), 500);
    }
  });

  app.post("/verify", async (c) => {
    try {
      const body = await c.req.json();
      const response = await facilitator.handleRequest({ method: "POST", path: "/verify", body });
      return c.json(response.body, response.status as any);
    } catch (error) {
      return c.json(formatError(error), 500);
    }
  });

  app.post("/settle", async (c) => {
    try {
      const body = await c.req.json();
      const response = await facilitator.handleRequest({ method: "POST", path: "/settle", body });
      return c.json(response.body, response.status as any);
    } catch (error) {
      return c.json(formatError(error), 500);
    }
  });

  return app;
}
