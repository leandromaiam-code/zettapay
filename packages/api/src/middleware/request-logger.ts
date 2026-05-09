import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { pinoHttp, type HttpLogger } from "pino-http";
import { baseLogger, REQUEST_ID_HEADER } from "../lib/logger.js";

const HEADER = REQUEST_ID_HEADER;

function genReqId(req: IncomingMessage, res: ServerResponse): string {
  const incoming = req.headers[HEADER];
  const id =
    (Array.isArray(incoming) ? incoming[0] : incoming)?.toString().trim() ||
    `req_${randomUUID().replace(/-/g, "")}`;
  res.setHeader(HEADER, id);
  return id;
}

export function buildRequestLogger(): HttpLogger {
  return pinoHttp({
    logger: baseLogger,
    genReqId,
    customLogLevel(_req, res, err) {
      if (err || res.statusCode >= 500) return "error";
      if (res.statusCode >= 400) return "warn";
      return "info";
    },
    customSuccessMessage(_req, res) {
      return `request completed ${res.statusCode}`;
    },
    customErrorMessage(_req, res, err) {
      return `request failed ${res.statusCode}: ${err.message}`;
    },
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url,
          remoteAddress: req.remoteAddress,
        };
      },
      res(res) {
        return { statusCode: res.statusCode };
      },
    },
  });
}

export { HEADER as REQUEST_ID_HEADER };
