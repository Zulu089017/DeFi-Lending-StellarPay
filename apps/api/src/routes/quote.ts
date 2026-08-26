import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { routeRateLimiter } from "../middleware/rate-limiter.js";

/** Quote endpoints are cheap but callable in tight loops by clients, so
 *  they get a stricter per-IP limit than the global 300/min. */
const QUOTE_MAX_PER_MIN = 60;

const QuoteWrap = z.object({
  sourceChain: z.enum(["ethereum", "polygon", "solana"]),
  token: z.string(),
  amount: z.string(),
  stellarDest: z.string(),
});

const QuoteUnwrap = z.object({
  amount: z.string(),
  sourceChain: z.enum(["ethereum", "polygon", "solana"]),
  sourceAddr: z.string(),
});

/** Quote endpoints. The scaffold returns a fixed-fee estimate; production
 *  computes fees from real-time gas oracles. */
export async function quoteRoutes(app: FastifyInstance) {
  app.addHook("preHandler", routeRateLimiter("quote", QUOTE_MAX_PER_MIN));

  app.post("/v1/quote/wrap", async (req, reply) => {
    const body = QuoteWrap.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
    const bridgeFee = "1000000"; // 0.1 wTKN in 7-decimal
    return {
      bridgeFee,
      estimatedTime: "30-90s",
      rate: "1:1",
    };
  });

  app.post("/v1/quote/unwrap", async (req, reply) => {
    const body = QuoteUnwrap.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
    return {
      bridgeFee: "0",
      estimatedTime: "30-120s",
      rate: "1:1",
    };
  });
}
