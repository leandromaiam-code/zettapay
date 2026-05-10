import { getServiceInfo } from "./version.js";

export type OpenApiDocument = Record<string, unknown>;

const API_KEY_HEADER = "x-zettapay-api-key";

const tags = [
  {
    name: "Merchants",
    description:
      "Onboard merchants and manage per-account fraud velocity controls.",
  },
  {
    name: "Payments",
    description:
      "One-shot USDC transfers settled on Solana. Optionally signed by an AI agent via the open x402 header.",
  },
  {
    name: "Subscriptions",
    description:
      "Recurring USDC charges: daily, weekly, or monthly intervals scoped to a merchant.",
  },
  {
    name: "Analytics",
    description: "Aggregate merchant payment metrics — TPV, MRR, conversion.",
  },
  {
    name: "Webhooks",
    description:
      "Webhook signature verification for inbound deliveries from ZettaPay.",
  },
  {
    name: "System",
    description: "Liveness, build info, and machine-readable service metadata.",
  },
];

const components = {
  securitySchemes: {
    ApiKeyAuth: {
      type: "apiKey",
      in: "header",
      name: API_KEY_HEADER,
      description:
        "Per-merchant API key issued at registration. Treat as a secret.",
    },
    X402Payment: {
      type: "apiKey",
      in: "header",
      name: "x-402-payment",
      description:
        "Base58-encoded signed Solana transfer carrying USDC from payer to merchant. " +
        "Optional on POST /pay — when present, the facilitator submits the tx and short-circuits the polling loop.",
    },
  },
  schemas: {
    Error: {
      type: "object",
      required: ["error"],
      properties: {
        error: {
          type: "object",
          required: ["code", "message"],
          properties: {
            code: { type: "string", example: "bad_request" },
            message: {
              type: "string",
              example: 'Field "amount" must be a positive number',
            },
          },
        },
      },
    },
    Merchant: {
      type: "object",
      required: [
        "id",
        "name",
        "email",
        "walletAddress",
        "apiKey",
        "createdAt",
      ],
      properties: {
        id: { type: "string", example: "mer_01H8XQ8E5K3Z7P2N4Y6F0J1B2C" },
        name: { type: "string", example: "Acme Robotics" },
        email: { type: "string", format: "email", example: "ops@acme.io" },
        walletAddress: {
          type: "string",
          description: "Base58 Solana public key receiving USDC settlements.",
          example: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
        },
        webhookUrl: {
          type: ["string", "null"],
          format: "uri",
          example: "https://acme.io/webhooks/zettapay",
        },
        apiKey: {
          type: "string",
          description:
            "Returned only at creation. Persist it now — ZettaPay never exposes it again.",
          example: "zp_live_8f4a...e21",
        },
        webhookSecret: {
          type: ["string", "null"],
          description:
            "HMAC-SHA256 signing secret used to verify webhook deliveries. Returned only at creation.",
        },
        createdAt: { type: "string", format: "date-time" },
      },
    },
    MerchantPublic: {
      type: "object",
      required: ["id", "name", "walletAddress"],
      properties: {
        id: { type: "string" },
        name: { type: "string" },
        email: { type: "string", format: "email" },
        walletAddress: { type: "string" },
        webhookUrl: { type: ["string", "null"], format: "uri" },
        maxPaymentsPerMinute: { type: "integer", minimum: 0, example: 60 },
        maxAmountPerHour: { type: "number", minimum: 0, example: 5000 },
      },
    },
    Payment: {
      type: "object",
      required: [
        "id",
        "merchantId",
        "amount",
        "currency",
        "status",
        "createdAt",
      ],
      properties: {
        id: { type: "string", example: "pay_01H8XQA9R3M5Q9V0W2P3K7T8Y9" },
        merchantId: { type: "string" },
        amount: {
          type: "number",
          minimum: 0,
          description:
            "Decimal amount in the requested currency (USDC by default).",
          example: 12.5,
        },
        amountUsdc: {
          type: "number",
          deprecated: true,
          description:
            "Legacy alias for `amount`. Prefer the canonical `amount` + `currency` pair.",
        },
        currency: { type: "string", example: "USDC" },
        payerWallet: {
          type: ["string", "null"],
          description:
            "Base58 wallet binding the payment to a specific payer when known up-front.",
        },
        status: {
          type: "string",
          enum: ["pending", "completed", "failed", "expired"],
          example: "pending",
        },
        txSignature: {
          type: ["string", "null"],
          description:
            "Solana transaction signature once the transfer is observed on-chain.",
        },
        metadata: {
          type: ["object", "null"],
          additionalProperties: true,
        },
        createdAt: { type: "string", format: "date-time" },
        completedAt: { type: ["string", "null"], format: "date-time" },
      },
    },
    Subscription: {
      type: "object",
      required: [
        "id",
        "merchantId",
        "customerWallet",
        "amount",
        "currency",
        "interval",
        "status",
        "nextChargeAt",
      ],
      properties: {
        id: { type: "string", example: "sub_01H8XQB7C2N4Q6V8W0X2Y4Z6A8" },
        merchantId: { type: "string" },
        customerWallet: { type: "string" },
        amount: { type: "number", minimum: 0 },
        currency: { type: "string", example: "USDC" },
        interval: {
          type: "string",
          enum: ["daily", "weekly", "monthly"],
        },
        status: {
          type: "string",
          enum: ["active", "canceled", "paused"],
        },
        nextChargeAt: { type: "string", format: "date-time" },
        metadata: {
          type: ["object", "null"],
          additionalProperties: true,
        },
        createdAt: { type: "string", format: "date-time" },
      },
    },
    AnalyticsSnapshot: {
      type: "object",
      properties: {
        tpv: {
          type: "object",
          description: "Total payment volume in USDC across windows.",
          properties: {
            today: { type: "number", example: 142.75 },
            week: { type: "number", example: 1820.5 },
            month: { type: "number", example: 7340.2 },
          },
        },
        mrr: { type: "number", example: 980.0 },
        conversionRate: {
          type: "number",
          minimum: 0,
          maximum: 1,
          example: 0.78,
        },
        topCustomers: {
          type: "array",
          items: {
            type: "object",
            properties: {
              wallet: { type: "string" },
              total: { type: "number" },
              count: { type: "integer" },
            },
          },
        },
      },
      additionalProperties: true,
    },
    RegisterMerchantRequest: {
      type: "object",
      required: ["name", "email", "walletAddress"],
      properties: {
        name: { type: "string", minLength: 2, maxLength: 120 },
        email: { type: "string", format: "email", maxLength: 254 },
        walletAddress: {
          type: "string",
          description: "Base58-encoded Solana wallet address.",
        },
        webhookUrl: {
          type: ["string", "null"],
          format: "uri",
          description: "Must be HTTPS — ZettaPay rejects http:// destinations.",
        },
      },
    },
    UpdateVelocityRequest: {
      type: "object",
      required: ["maxPaymentsPerMinute", "maxAmountPerHour"],
      properties: {
        maxPaymentsPerMinute: {
          type: "integer",
          minimum: 0,
          maximum: 1000,
          description: "Set to 0 to disable the per-minute count cap.",
        },
        maxAmountPerHour: {
          type: "number",
          minimum: 0,
          maximum: 1_000_000,
          description: "Set to 0 to disable the rolling hour amount cap.",
        },
      },
    },
    CreatePaymentRequest: {
      type: "object",
      required: ["merchantId", "amount"],
      properties: {
        merchantId: { type: "string", maxLength: 64 },
        amount: {
          type: "number",
          exclusiveMinimum: 0,
          maximum: 1_000_000,
          description: "Amount to charge in `currency` (defaults to USDC).",
        },
        amountUsdc: {
          type: "number",
          deprecated: true,
          description: "Legacy alias for `amount`. Use `amount` instead.",
        },
        currency: {
          type: "string",
          maxLength: 8,
          description: "Defaults to USDC. Other tickers normalized internally.",
          example: "USDC",
        },
        payerWallet: {
          type: ["string", "null"],
          description:
            "Optional payer Solana wallet. When supplied, the payment is bound on-chain via memo.",
        },
        metadata: {
          type: ["object", "null"],
          additionalProperties: true,
          description: "Free-form merchant metadata, returned verbatim.",
        },
      },
    },
    CreateSubscriptionRequest: {
      type: "object",
      required: ["customerWallet", "amount", "interval"],
      properties: {
        customerWallet: { type: "string" },
        amount: { type: "number", exclusiveMinimum: 0 },
        interval: { type: "string", enum: ["daily", "weekly", "monthly"] },
        currency: { type: "string", example: "USDC" },
        nextChargeAt: {
          type: "string",
          format: "date-time",
          description:
            "Optional ISO-8601 timestamp for the first charge. Defaults to now + interval.",
        },
        metadata: { type: ["object", "null"], additionalProperties: true },
      },
    },
    VerifySignatureRequest: {
      type: "object",
      required: ["payload", "signature", "timestamp"],
      properties: {
        payload: {
          type: "string",
          description:
            "Raw webhook body as received (do not re-serialize — bytes must match).",
        },
        signature: {
          type: "string",
          description: "`x-zettapay-signature` header value (`sha256=<hex>`).",
        },
        timestamp: {
          type: "string",
          description: "`x-zettapay-timestamp` header value (unix seconds).",
        },
      },
    },
    VerifySignatureResponse: {
      oneOf: [
        {
          type: "object",
          required: ["valid"],
          properties: { valid: { type: "boolean", enum: [true] } },
        },
        {
          type: "object",
          required: ["valid", "reason"],
          properties: {
            valid: { type: "boolean", enum: [false] },
            reason: {
              type: "string",
              enum: [
                "invalid_format",
                "stale_timestamp",
                "signature_mismatch",
              ],
            },
          },
        },
      ],
    },
  },
} as const;

const merchantIdParam = {
  name: "id",
  in: "path",
  required: true,
  schema: { type: "string" },
  description: "Merchant identifier returned by POST /merchants/register.",
};

const subscriptionIdParam = {
  name: "id",
  in: "path",
  required: true,
  schema: { type: "string" },
  description: "Subscription identifier returned by POST /subscriptions.",
};

const idempotencyHeader = {
  name: "Idempotency-Key",
  in: "header",
  required: false,
  schema: { type: "string", maxLength: 255 },
  description:
    "Optional client-supplied key. Re-issuing the same request within 24h returns the original result instead of a duplicate write.",
};

const errorResponse = (description: string) => ({
  description,
  content: {
    "application/json": {
      schema: { $ref: "#/components/schemas/Error" },
    },
  },
});

const paths = {
  "/": {
    get: {
      tags: ["System"],
      summary: "Service status",
      description: "Liveness payload — uptime and current server time.",
      responses: {
        "200": {
          description: "Service is up.",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  status: { type: "string", example: "ok" },
                  service: { type: "string", example: "@zettapay/api" },
                  uptimeSec: { type: "integer", example: 3621 },
                  now: { type: "string", format: "date-time" },
                },
              },
            },
          },
        },
      },
    },
  },
  "/healthz": {
    get: {
      tags: ["System"],
      summary: "Readiness probe",
      description:
        "Returns 200 while accepting traffic. Returns 503 with `{ status: 'draining' }` during graceful shutdown so load balancers can drain in-flight requests.",
      responses: {
        "200": {
          description: "Healthy.",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: { status: { type: "string", example: "ok" } },
              },
            },
          },
        },
        "503": errorResponse("Server is draining (shutdown in progress)."),
      },
    },
  },
  "/merchants/register": {
    post: {
      tags: ["Merchants"],
      summary: "Register a merchant",
      description:
        "Provisions a merchant and returns the API key + webhook secret. Both are returned exactly once — store them immediately.",
      parameters: [idempotencyHeader],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/RegisterMerchantRequest" },
            example: {
              name: "Acme Robotics",
              email: "ops@acme.io",
              walletAddress: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
              webhookUrl: "https://acme.io/webhooks/zettapay",
            },
          },
        },
      },
      responses: {
        "201": {
          description: "Merchant created.",
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["merchant"],
                properties: {
                  merchant: { $ref: "#/components/schemas/Merchant" },
                },
              },
            },
          },
        },
        "400": errorResponse("Invalid payload."),
      },
    },
  },
  "/merchants/{id}/velocity": {
    put: {
      tags: ["Merchants"],
      summary: "Update fraud velocity caps",
      description:
        "Adjusts per-merchant rate ceilings used by the fraud detector. Caps are sticky until the next call.",
      parameters: [merchantIdParam],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/UpdateVelocityRequest" },
            example: { maxPaymentsPerMinute: 60, maxAmountPerHour: 5000 },
          },
        },
      },
      responses: {
        "200": {
          description: "Updated.",
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["merchant"],
                properties: {
                  merchant: { $ref: "#/components/schemas/MerchantPublic" },
                },
              },
            },
          },
        },
        "400": errorResponse("Invalid payload or value out of range."),
        "404": errorResponse("Merchant not found."),
      },
    },
  },
  "/pay": {
    post: {
      tags: ["Payments"],
      summary: "Create a payment",
      description:
        "Creates a USDC payment. AI agents may pre-sign the transfer and submit it via the `x-402-payment` header — the facilitator will broadcast it and short-circuit the polling loop.",
      security: [{}, { X402Payment: [] }],
      parameters: [
        idempotencyHeader,
        {
          name: "x-402-payment",
          in: "header",
          required: false,
          schema: { type: "string" },
          description:
            "Base58-encoded signed Solana transfer (x402 spec). Present only for AI-agent flows.",
        },
      ],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/CreatePaymentRequest" },
            example: {
              merchantId: "mer_01H8XQ8E5K3Z7P2N4Y6F0J1B2C",
              amount: 12.5,
              currency: "USDC",
              payerWallet: "5ZWj7a1f8tWkjBESHKgrLmXshuXxqeY5SYNZwAn3rKgZ",
              metadata: { orderId: "ord_4711" },
            },
          },
        },
      },
      responses: {
        "201": {
          description: "Payment created.",
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["payment"],
                properties: {
                  payment: { $ref: "#/components/schemas/Payment" },
                  txSignature: { type: ["string", "null"] },
                },
              },
            },
          },
        },
        "400": errorResponse("Invalid payload."),
        "404": errorResponse("Merchant not found."),
        "429": errorResponse("Velocity cap exceeded."),
      },
    },
  },
  "/subscriptions": {
    post: {
      tags: ["Subscriptions"],
      summary: "Create a subscription",
      description:
        "Creates a recurring USDC charge for the authenticated merchant. The first charge fires at `nextChargeAt` (defaults to now + interval).",
      security: [{ ApiKeyAuth: [] }],
      parameters: [idempotencyHeader],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/CreateSubscriptionRequest" },
            example: {
              customerWallet: "5ZWj7a1f8tWkjBESHKgrLmXshuXxqeY5SYNZwAn3rKgZ",
              amount: 9.99,
              interval: "monthly",
              currency: "USDC",
            },
          },
        },
      },
      responses: {
        "201": {
          description: "Subscription created.",
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["subscription"],
                properties: {
                  subscription: { $ref: "#/components/schemas/Subscription" },
                },
              },
            },
          },
        },
        "400": errorResponse("Invalid payload."),
        "401": errorResponse("Missing or invalid API key."),
      },
    },
    get: {
      tags: ["Subscriptions"],
      summary: "List subscriptions",
      description: "Lists subscriptions for the authenticated merchant.",
      security: [{ ApiKeyAuth: [] }],
      parameters: [
        {
          name: "limit",
          in: "query",
          required: false,
          schema: { type: "integer", minimum: 1, maximum: 200, default: 50 },
        },
      ],
      responses: {
        "200": {
          description: "OK.",
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["subscriptions"],
                properties: {
                  subscriptions: {
                    type: "array",
                    items: { $ref: "#/components/schemas/Subscription" },
                  },
                },
              },
            },
          },
        },
        "401": errorResponse("Missing or invalid API key."),
      },
    },
  },
  "/subscriptions/{id}": {
    get: {
      tags: ["Subscriptions"],
      summary: "Retrieve a subscription",
      security: [{ ApiKeyAuth: [] }],
      parameters: [subscriptionIdParam],
      responses: {
        "200": {
          description: "OK.",
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["subscription"],
                properties: {
                  subscription: { $ref: "#/components/schemas/Subscription" },
                },
              },
            },
          },
        },
        "401": errorResponse("Missing or invalid API key."),
        "404": errorResponse("Subscription not found."),
      },
    },
  },
  "/subscriptions/{id}/cancel": {
    post: {
      tags: ["Subscriptions"],
      summary: "Cancel a subscription",
      description:
        "Marks the subscription `canceled`. No further charges will be scheduled. The action is idempotent.",
      security: [{ ApiKeyAuth: [] }],
      parameters: [subscriptionIdParam],
      responses: {
        "200": {
          description: "Canceled.",
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["subscription"],
                properties: {
                  subscription: { $ref: "#/components/schemas/Subscription" },
                },
              },
            },
          },
        },
        "401": errorResponse("Missing or invalid API key."),
        "404": errorResponse("Subscription not found."),
      },
    },
  },
  "/analytics": {
    get: {
      tags: ["Analytics"],
      summary: "Merchant analytics snapshot",
      description:
        "Returns aggregate metrics scoped to the authenticated merchant: TPV by window, MRR, conversion rate, and top customers.",
      security: [{ ApiKeyAuth: [] }],
      responses: {
        "200": {
          description: "OK.",
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["analytics"],
                properties: {
                  analytics: { $ref: "#/components/schemas/AnalyticsSnapshot" },
                },
              },
            },
          },
        },
        "401": errorResponse("Missing or invalid API key."),
      },
    },
  },
  "/verify-signature": {
    post: {
      tags: ["Webhooks"],
      summary: "Verify a webhook signature",
      description:
        "Constant-time HMAC-SHA256 verification of an inbound webhook delivery. The merchant authenticates with their API key and replays the payload, signature, and timestamp from the suspect request. The secret is never echoed.",
      security: [{ ApiKeyAuth: [] }],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/VerifySignatureRequest" },
          },
        },
      },
      responses: {
        "200": {
          description: "Verification result.",
          content: {
            "application/json": {
              schema: {
                $ref: "#/components/schemas/VerifySignatureResponse",
              },
            },
          },
        },
        "400": errorResponse(
          "Merchant has no signing secret, or payload missing fields.",
        ),
        "401": errorResponse("Missing or invalid API key."),
      },
    },
  },
  "/verify-signature/info": {
    get: {
      tags: ["Webhooks"],
      summary: "Signature scheme metadata",
      description:
        "Returns the algorithm, header names, and signed-string template used for webhook signatures. Safe to call without authentication.",
      responses: {
        "200": {
          description: "Scheme metadata.",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  algorithm: { type: "string", example: "HMAC-SHA256" },
                  signatureFormat: {
                    type: "string",
                    example: "sha256=<hex>",
                  },
                  signedString: {
                    type: "string",
                    example: "${timestamp}.${payload}",
                  },
                  headers: {
                    type: "object",
                    properties: {
                      signature: {
                        type: "string",
                        example: "x-zettapay-signature",
                      },
                      timestamp: {
                        type: "string",
                        example: "x-zettapay-timestamp",
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
} as const;

let cached: OpenApiDocument | null = null;

export function getOpenApiDocument(
  options: { serverUrl?: string } = {},
): OpenApiDocument {
  if (cached && !options.serverUrl) return cached;

  const info = getServiceInfo();
  const servers: Array<Record<string, unknown>> = [];
  if (options.serverUrl) {
    servers.push({ url: options.serverUrl, description: "This deployment" });
  }
  servers.push(
    { url: "https://api.zettapay.dev", description: "Devnet" },
    {
      url: "http://localhost:3001",
      description: "Local development",
    },
  );

  const doc: OpenApiDocument = {
    openapi: "3.1.0",
    info: {
      title: "ZettaPay API",
      version: info.version,
      summary:
        "Solana-native USDC payments for humans and AI agents. Stripe-grade webhooks, x402 + MCP support, sub-second settlement.",
      description:
        [
          "ZettaPay is the open payment protocol for the agentic economy.",
          "",
          "**Auth.** Most endpoints take an `x-zettapay-api-key` header issued at registration. The `POST /pay` endpoint is intentionally open so AI agents can mint payments without holding merchant credentials; the optional `x-402-payment` header carries a pre-signed Solana transfer per the [x402 spec](https://github.com/anthropics/x402).",
          "",
          "**Idempotency.** Mutating endpoints accept an `Idempotency-Key` header. Replays inside the 24h window return the original result rather than producing duplicate side effects.",
          "",
          "**Money.** All amounts are decimal — never base units. USDC is the canonical currency and the default when `currency` is omitted.",
        ].join("\n"),
      contact: {
        name: "ZettaPay",
        url: "https://zettapay.vercel.app",
      },
      license: { name: "MIT", url: "https://opensource.org/licenses/MIT" },
    },
    servers,
    tags,
    paths,
    components,
  };

  if (!options.serverUrl) cached = doc;
  return doc;
}
