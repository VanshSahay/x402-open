import type { Request, Response, Router } from "express";
import type { Facilitator } from "./facilitator";

export function createExpressAdapter(
  facilitator: Facilitator,
  router: Router,
  basePath: string = ""
): void {
  const normalizePath = (path: string) => {
    const normalized = basePath + path;
    return normalized || "/";
  };

  router.get(normalizePath("/supported"), async (req: Request, res: Response) => {
    try {
      const response = await facilitator.handleRequest({ method: "GET", path: "/supported" });
      res.status(response.status).json(response.body);
    } catch (error) {
      res.status(500).json({
        error: "Internal server error",
        message: error instanceof Error ? error.message : "Unknown error",
      });
    }
  });

  router.post(normalizePath("/verify"), async (req: Request, res: Response) => {
    try {
      const response = await facilitator.handleRequest({ method: "POST", path: "/verify", body: req.body });
      res.status(response.status).json(response.body);
    } catch (error) {
      res.status(500).json({
        error: "Internal server error",
        message: error instanceof Error ? error.message : "Unknown error",
      });
    }
  });

  router.post(normalizePath("/settle"), async (req: Request, res: Response) => {
    try {
      const response = await facilitator.handleRequest({ method: "POST", path: "/settle", body: req.body });
      res.status(response.status).json(response.body);
    } catch (error) {
      res.status(500).json({
        error: "Internal server error",
        message: error instanceof Error ? error.message : "Unknown error",
      });
    }
  });
}


