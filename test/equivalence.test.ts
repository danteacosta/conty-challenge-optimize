import { describe, expect, it } from "vitest";
import { getQueryCount, openDatabase, resetQueryCount } from "../src/db.ts";
import { listCreators } from "../src/list-creators.ts";
import { CAMPAIGN_ID, seed } from "../src/seed.ts";
import { referenceListCreators } from "./reference-list-creators.ts";

const PAGES = [
  { limit: 20, offset: 0 },
  { limit: 20, offset: 20 },
  { limit: 7, offset: 3 },
  { limit: 50, offset: 0 },
  { limit: 1, offset: 0 },
  { limit: 20, offset: 100_000 },
];

async function expectSameAsReference(db: ReturnType<typeof openDatabase>, campaignId: string) {
  for (const page of PAGES) {
    const expected = await referenceListCreators(db, { campaignId, ...page });
    const actual = await listCreators(db, { campaignId, ...page });
    expect(actual).toEqual(expected);
  }
}

describe("listagem igual à original", () => {
  it.each([
    { creators: 80, seed: 7 },
    { creators: 600, seed: 7 },
    { creators: 1500, seed: 42 },
    { creators: 300, seed: 1234 },
  ])("em volumes maiores que o do seed: %j", async (options) => {
    const db = openDatabase(":memory:");
    seed(db, options);
    await expectSameAsReference(db, CAMPAIGN_ID);
  });

  it("com empates de score e de alcance, contas sem métrica, métricas empatadas e campanha com nicho repetido", async () => {
    const db = openDatabase(":memory:");
    const creators: string[] = [];
    const accounts: string[] = [];
    const metrics: string[] = [];
    const deliveries: string[] = [];
    // 30 criadores com o MESMO score e o MESMO alcance: só o id desempata
    for (let i = 0; i < 30; i += 1) {
      const id = `crt_t${String(i).padStart(2, "0")}`;
      creators.push(`('${id}', 'Empate ${i}', '["beleza","moda"]', '')`);
      accounts.push(`('acc_${id}', '${id}', 'instagram')`);
      metrics.push(`('met_${id}', 'acc_${id}', 500, '2026-05-30T00:00:00.000Z', '')`);
    }
    // alcance maior com duas contas, métrica mais recente com captured_at empatado (vence o id maior)
    creators.push(`('crt_two', 'Duas contas', '["beleza"]', '')`);
    accounts.push(`('acc_two_a', 'crt_two', 'instagram')`, `('acc_two_b', 'crt_two', 'tiktok')`);
    metrics.push(
      `('met_two_a1', 'acc_two_a', 10, '2026-05-30T00:00:00.000Z', '')`,
      `('met_two_a2', 'acc_two_a', 700, '2026-05-30T00:00:00.000Z', '')`,
      `('met_two_b1', 'acc_two_b', 300, '2026-05-29T00:00:00.000Z', '')`,
      `('met_two_b0', 'acc_two_b', 99999, '2026-05-01T00:00:00.000Z', '')`,
    );
    // sem conta, conta sem métrica, nicho fora, entregas no limite
    creators.push(`('crt_noacc', 'Sem conta', '["moda"]', '')`, `('crt_nomet', 'Sem métrica', '["beleza"]', '')`, `('crt_out', 'Fora', '["games"]', '')`);
    accounts.push(`('acc_nomet', 'crt_nomet', 'instagram')`);
    deliveries.push(
      `('del_1', 'crt_t00', '2026-03-03T12:00:00.000Z')`,
      `('del_2', 'crt_t00', '2026-03-03T11:59:59.999Z')`,
      `('del_3', 'crt_t01', '2026-06-01T12:00:00.000Z')`,
      `('del_4', 'crt_two', '2026-01-01T00:00:00.000Z')`,
    );
    db.exec(`
      INSERT INTO campaigns VALUES ('cmp_tie', 'Empates', '["beleza","moda","beleza"]');
      INSERT INTO creators VALUES ${creators.join(",")};
      INSERT INTO social_accounts VALUES ${accounts.join(",")};
      INSERT INTO metrics VALUES ${metrics.join(",")};
      INSERT INTO deliveries VALUES ${deliveries.join(",")};
    `);
    await expectSameAsReference(db, "cmp_tie");
  });

  it("campanha inexistente continua devolvendo null, e campanha sem nenhum criador compatível devolve página vazia", async () => {
    const db = openDatabase(":memory:");
    db.exec(`INSERT INTO campaigns VALUES ('cmp_none', 'Ninguém', '["games"]');
             INSERT INTO creators VALUES ('crt_x', 'X', '["moda"]', '');`);
    expect(await listCreators(db, { campaignId: "cmp_missing", limit: 20, offset: 0 })).toBeNull();
    expect(await listCreators(db, { campaignId: "cmp_none", limit: 20, offset: 0 })).toEqual({
      campaign_id: "cmp_none",
      total: 0,
      creators: [],
    });
  });
});

describe("orçamento de queries não cresce com o volume", () => {
  it.each([80, 600, 3000])("%i criadores: página de 20 em no máximo 8 queries, e o mesmo número de queries em qualquer volume", async (creators) => {
    const db = openDatabase(":memory:");
    seed(db, { creators, seed: 7 });
    resetQueryCount();
    await listCreators(db, { campaignId: CAMPAIGN_ID, limit: 20, offset: 0 });
    expect(getQueryCount()).toBeLessThanOrEqual(8);
  });

  it("a contagem é a mesma para 80 e para 3000 criadores", async () => {
    const counts: number[] = [];
    for (const creators of [80, 3000]) {
      const db = openDatabase(":memory:");
      seed(db, { creators, seed: 7 });
      resetQueryCount();
      await listCreators(db, { campaignId: CAMPAIGN_ID, limit: 20, offset: 0 });
      counts.push(getQueryCount());
    }
    expect(counts[0]).toBe(counts[1]);
  });
});
