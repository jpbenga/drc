let z;
try {
  ({ z } = require('zod'));
} catch (err) {
  ({ z } = require('./zod-lite'));
}

const oddsOutcomeSchema = z
  .object({
    value: z.string().optional(),
    name: z.string().optional(),
    odd: z.union([z.number(), z.string()]).optional(),
    price: z.union([z.number(), z.string()]).optional(),
    odds: z.union([z.number(), z.string()]).optional(),
  })
  .strict()
  .transform((val) => {
    const rawOdd = val.odd ?? val.price ?? val.odds;
    const odd = rawOdd === undefined ? undefined : Number(rawOdd);
    return { ...val, odd };
  });

const oddsMarketSchema = z
  .object({
    name: z.string(),
    values: z.array(oddsOutcomeSchema).optional(),
    outcomes: z.array(oddsOutcomeSchema).optional(),
  })
  .strict();

const bookmakerSchema = z
  .object({
    name: z.string().optional(),
    bets: z
      .array(
        z.object({
          id: z.number().optional(),
          name: z.string(),
          values: z.array(oddsOutcomeSchema).optional(),
          outcomes: z.array(oddsOutcomeSchema).optional(),
        }),
      )
      .optional(),
  })
  .strict();

const oddsSchema = z
  .object({
    markets: z.array(oddsMarketSchema).optional(),
    bookmakers: z.array(bookmakerSchema).optional(),
  })
  .strict();

const teamSchema = z
  .object({
    id: z.number(),
    name: z.string(),
  })
  .strict();

const fixtureCoreSchema = z
  .object({
    id: z.number(),
    date: z.string(),
    status: z.object({ short: z.string().optional() }).partial().optional(),
  })
  .strict();

const goalsSchema = z
  .object({
    home: z.number().nullable().optional(),
    away: z.number().nullable().optional(),
  })
  .strict();

const statsSchema = z
  .object({
    expected_goals: z.number().optional(),
  })
  .strict();

const fixtureSchema = z
  .object({
    fixture: fixtureCoreSchema,
    league: z.object({ id: z.number(), round: z.string().optional() }).strict(),
    teams: z.object({ home: teamSchema, away: teamSchema }).strict(),
    goals: goalsSchema,
    stats: z.object({ home: statsSchema.optional(), away: statsSchema.optional() }).partial().optional(),
    odds: oddsSchema.optional(),
    metaHome: z.record(z.any()).optional(),
    metaAway: z.record(z.any()).optional(),
  })
  .strict();

const fixturesResponseSchema = z.object({ response: z.array(fixtureSchema) }).strict();

module.exports = {
  fixtureSchema,
  oddsSchema,
  fixturesResponseSchema,
};
