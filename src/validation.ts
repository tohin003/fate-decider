/**
 * Boundary validation: JSON schemas (compiled by Fastify's AJV) and the numeric
 * limits they enforce. Nothing malformed, negative, oversized, or overflowing
 * reaches the economy code — it is rejected here with a 400.
 */

export const LIMITS = {
  /** Max value for any single amount or price. Keeps balances well inside int8. */
  MAX_AMOUNT: 1_000_000_000,
  /** playerId / itemId / rewardId charset and length. */
  ID_PATTERN: "^[A-Za-z0-9_-]{1,64}$",
  MAX_REASON_LEN: 256,
  /** Upper bound on a client-supplied Idempotency-Key header. */
  MAX_IDEMPOTENCY_KEY_LEN: 200,
} as const;

const amountSchema = {
  // `integer` rejects floats, strings, null, booleans; bounds reject <=0 and overflow.
  type: "integer",
  minimum: 1,
  maximum: LIMITS.MAX_AMOUNT,
} as const;

const idSchema = { type: "string", pattern: LIMITS.ID_PATTERN } as const;

const playerIdParams = {
  type: "object",
  required: ["playerId"],
  properties: { playerId: idSchema },
} as const;

const rewardIdParams = {
  type: "object",
  required: ["rewardId"],
  properties: { rewardId: idSchema },
} as const;

// Headers: only constrain our own; leave all the standard headers untouched
// (no additionalProperties:false here — that would reject host, content-type, ...).
const idempotencyHeaders = {
  type: "object",
  properties: {
    "idempotency-key": {
      type: "string",
      minLength: 1,
      maxLength: LIMITS.MAX_IDEMPOTENCY_KEY_LEN,
    },
  },
} as const;

export const creditSchema = {
  params: playerIdParams,
  headers: idempotencyHeaders,
  body: {
    type: "object",
    additionalProperties: false,
    required: ["amount", "reason"],
    properties: {
      amount: amountSchema,
      reason: { type: "string", maxLength: LIMITS.MAX_REASON_LEN },
    },
  },
} as const;

export const purchaseSchema = {
  params: playerIdParams,
  headers: idempotencyHeaders,
  body: {
    type: "object",
    additionalProperties: false,
    required: ["itemId", "price"],
    properties: {
      itemId: idSchema,
      price: amountSchema,
    },
  },
} as const;

export const claimSchema = {
  params: rewardIdParams,
  headers: idempotencyHeaders,
  body: {
    type: "object",
    additionalProperties: false,
    required: ["playerId"],
    properties: {
      playerId: idSchema,
    },
  },
} as const;

export const getWalletSchema = {
  params: playerIdParams,
} as const;

// Exported for use by the purchase/claim routes added in later phases.
export { idSchema, amountSchema, playerIdParams, rewardIdParams, idempotencyHeaders };
