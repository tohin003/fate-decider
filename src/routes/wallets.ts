import type { FastifyInstance } from "fastify";
import { creditSchema, getWalletSchema } from "../validation.js";
import { idempotencyContext, runIdempotent } from "../idempotency.js";
import { creditEffect, readWallet } from "../services/economy.js";

interface PlayerParams {
  playerId: string;
}
interface CreditBody {
  amount: number;
  reason: string;
}

export function registerWalletRoutes(app: FastifyInstance): void {
  app.post<{ Params: PlayerParams; Body: CreditBody }>(
    "/v1/wallets/:playerId/credit",
    { schema: creditSchema },
    async (req, reply) => {
      const { playerId } = req.params;
      const { amount, reason } = req.body;
      const ctx = idempotencyContext(req);

      const outcome = await runIdempotent(app.db, ctx, (client) =>
        creditEffect(client, playerId, amount, reason, ctx.key),
      );

      if (outcome.replayed) reply.header("Idempotency-Replayed", "true");
      // Send the pre-serialized bytes so a replay is byte-identical to the original.
      return reply.code(outcome.status).type("application/json").send(outcome.bodyText);
    },
  );

  app.get<{ Params: PlayerParams }>(
    "/v1/wallets/:playerId",
    { schema: getWalletSchema },
    async (req, reply) => {
      const wallet = await readWallet(app.db, req.params.playerId);
      return reply.code(200).send(wallet);
    },
  );
}
