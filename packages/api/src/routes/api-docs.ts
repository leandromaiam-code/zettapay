import { Router, type Request, type Response } from "express";
import { getOpenApiDocument } from "../lib/openapi.js";

const SWAGGER_UI_VERSION = "5.17.14";
const SWAGGER_UI_BASE = `https://cdn.jsdelivr.net/npm/swagger-ui-dist@${SWAGGER_UI_VERSION}`;

function deriveServerUrl(req: Request): string {
  const proto = (req.headers["x-forwarded-proto"] as string) ?? req.protocol;
  const host = (req.headers["x-forwarded-host"] as string) ?? req.get("host");
  if (!host) return req.protocol + "://localhost";
  return `${proto.split(",")[0]?.trim()}://${host}`;
}

function renderDocsHtml(specUrl: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>ZettaPay API reference</title>
    <link rel="icon" href="data:," />
    <link rel="stylesheet" href="${SWAGGER_UI_BASE}/swagger-ui.css" />
    <style>
      body { margin: 0; background: #0a1612; }
      .topbar { display: none; }
      #swagger-ui { background: #f5e6c8; min-height: 100vh; }
      .swagger-ui .info .title { font-family: "Cormorant Garamond", Georgia, serif; }
    </style>
  </head>
  <body>
    <div id="swagger-ui"></div>
    <script src="${SWAGGER_UI_BASE}/swagger-ui-bundle.js" crossorigin></script>
    <script src="${SWAGGER_UI_BASE}/swagger-ui-standalone-preset.js" crossorigin></script>
    <script>
      window.addEventListener("load", function () {
        window.ui = SwaggerUIBundle({
          url: ${JSON.stringify(specUrl)},
          dom_id: "#swagger-ui",
          deepLinking: true,
          presets: [
            SwaggerUIBundle.presets.apis,
            SwaggerUIStandalonePreset,
          ],
          plugins: [SwaggerUIBundle.plugins.DownloadUrl],
          layout: "StandaloneLayout",
          tryItOutEnabled: true,
          persistAuthorization: true,
        });
      });
    </script>
  </body>
</html>`;
}

export function apiDocsRouter(): Router {
  const router = Router();

  router.get("/openapi.json", (req: Request, res: Response) => {
    const doc = getOpenApiDocument({ serverUrl: deriveServerUrl(req) });
    res.setHeader("cache-control", "public, max-age=300");
    res.json(doc);
  });

  router.get("/docs", (_req: Request, res: Response) => {
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.setHeader("cache-control", "public, max-age=300");
    res.send(renderDocsHtml("/openapi.json"));
  });

  return router;
}
