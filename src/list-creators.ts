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
     ranked AS (
       SELECT s.id, s.name, s.niche_score,
              COALESCE((SELECT SUM(COALESCE((
                SELECT m.views FROM metrics m WHERE m.account_id = a.id
                 ORDER BY m.captured_at DESC, m.id DESC LIMIT 1
              ), 0)) FROM social_accounts a WHERE a.creator_id = s.id), 0) AS latest_reach
         FROM scored s WHERE s.niche_score > 0
     ),
     page AS (
       SELECT * FROM ranked
        ORDER BY niche_score DESC, latest_reach DESC, js_string_key(id) ASC
        LIMIT ? OFFSET ?
     )
     SELECT p.id, p.name, p.niche_score, p.latest_reach,
            (SELECT COUNT(*) FROM deliveries d
              WHERE d.creator_id = p.id AND d.delivered_at >= ?) AS deliveries_90d
       FROM page p
      ORDER BY p.niche_score DESC, p.latest_reach DESC, js_string_key(p.id) ASC`,
    campaign.niches_json,
    input.limit,
    input.offset,
    deliveriesSince(),
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
