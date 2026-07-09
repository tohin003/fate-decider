import type { FastifyInstance } from "fastify";
import { claimSchema } from "../validation.js";
import { idempotencyContext, runIdempotent } from "../idempotency.js";
import { claimEffect } from "../services/economy.js";

interface RewardParams {
  rewardId: string;
}
interface ClaimBody {
  playerId: string;
}

export function registerRewardRoutes(app: FastifyInstance): void {
  app.post<{ Params: RewardParams; Body: ClaimBody }>(
    "/v1/rewards/:rewardId/claim",
    { schema: claimSchema },
    async (req, reply) => {
      const { rewardId } = req.params;
      const { playerId } = req.body;
      const ctx = idempotencyContext(req);

      const outcome = await runIdempotent(app.db, ctx, (client) =>
        claimEffect(client, rewardId, playerId),
      );

      if (outcome.replayed) reply.header("Idempotency-Replayed", "true");
      return reply.code(outcome.status).type("application/json").send(outcome.bodyText);
    },
  );
}
