import type { DatabaseSync } from "node:sqlite";
import { deliveriesSince } from "./clock.ts";
import { all, get } from "./db.ts";

export type CreatorMatch = {
  id: string;
  name: string;
  niche_score: number;
  latest_reach: number;
  deliveries_90d: number;
};

export type CreatorPage = {
  campaign_id: string;
  total: number;
  creators: CreatorMatch[];
};

type CampaignRow = { id: string; niches_json: string };
type CountRow = { n: number };

// niche_score = pares (nicho da campanha, nicho do criador) iguais, como no loop aninhado original.
const SCORED = `
  SELECT c.id AS id,
         c.name AS name,
         (SELECT COUNT(*)
            FROM json_each(c.niches_json) AS creator_niche
            JOIN json_each(?) AS campaign_niche ON creator_niche.value = campaign_niche.value) AS niche_score
    FROM creators c`;

export async function listCreators(
  db: DatabaseSync,
  input: { campaignId: string; limit: number; offset: number },
): Promise<CreatorPage | null> {
  const campaign = await get<CampaignRow>(db, "SELECT id, niches_json FROM campaigns WHERE id = ?", input.campaignId);
  if (!campaign) return null;

  // Alcance: a métrica mais recente de cada conta (captured_at, desempate por id decrescente), somada por criador.
  // Tudo numa query só, então o número de queries não depende de quantos criadores existem.
  const creators = await all<CreatorMatch>(
    db,
    `WITH scored AS (${SCORED}),
     latest_metric AS (
       SELECT a.creator_id AS creator_id,
              m.views AS views,
              ROW_NUMBER() OVER (PARTITION BY m.account_id ORDER BY m.captured_at DESC, m.id DESC) AS rn
         FROM metrics m
         JOIN social_accounts a ON a.id = m.account_id
     ),
     reach AS (
       SELECT creator_id, SUM(views) AS latest_reach FROM latest_metric WHERE rn = 1 GROUP BY creator_id
     ),
     delivered AS (
       SELECT creator_id, COUNT(*) AS n FROM deliveries WHERE delivered_at >= ? GROUP BY creator_id
     )
     SELECT s.id AS id,
            s.name AS name,
            s.niche_score AS niche_score,
            COALESCE(r.latest_reach, 0) AS latest_reach,
            COALESCE(d.n, 0) AS deliveries_90d
       FROM scored s
       LEFT JOIN reach r ON r.creator_id = s.id
       LEFT JOIN delivered d ON d.creator_id = s.id
      WHERE s.niche_score > 0
      ORDER BY s.niche_score DESC, latest_reach DESC, s.id ASC
      LIMIT ? OFFSET ?`,
    campaign.niches_json,
    deliveriesSince(),
    input.limit,
    input.offset,
  );

  // O total é separado da página para continuar correto quando o offset passa do fim.
  const total = await get<CountRow>(
    db,
    `SELECT COUNT(*) AS n FROM (${SCORED}) WHERE niche_score > 0`,
    campaign.niches_json,
  );

  return {
    campaign_id: input.campaignId,
    total: Number(total?.n ?? 0),
    creators: creators.map((row) => ({
      id: row.id,
      name: row.name,
      niche_score: Number(row.niche_score),
      latest_reach: Number(row.latest_reach),
      deliveries_90d: Number(row.deliveries_90d),
    })),
  };
}
