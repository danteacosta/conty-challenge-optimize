import { describe, expect, it } from "vitest";
import { getQueryCount, openDatabase, resetQueryCount } from "../src/db.ts";
import { listCreators } from "../src/list-creators.ts";

/** Sem transação aberta: um BEGIN novo só funciona se não houver outra (db.isTransaction só existe a partir do Node 24). */
function expectNoOpenTransaction(db: ReturnType<typeof openDatabase>) {
  db.exec("BEGIN");
  db.exec("ROLLBACK");
}

function database(creators: number) {
  const db = openDatabase(":memory:");
  db.prepare("INSERT INTO campaigns VALUES (?, ?, ?)").run("c", "Campanha", '["x"]');
  const insert = db.prepare("INSERT INTO creators VALUES (?, ?, ?, ?)");
  for (let i = 0; i < creators; i += 1) insert.run(`cr${i}`, `Criador ${i}`, '["x"]', "{}");
  return db;
}

describe("a página e o total vêm do mesmo estado, mesmo com escrita no meio da listagem", () => {
  // Um escritor que roda depois de `ticks` continuações da listagem. Antes da correção, algum `ticks` caía entre a consulta
  // da página e a do total e a resposta misturava os dois estados (total 0 com um criador na página).
  it.each([0, 1, 2, 3, 4, 5, 6])("escritor após %i continuações: a resposta é inteira do estado anterior ou do posterior", async (ticks) => {
    const db = database(3);
    const pending = listCreators(db, { campaignId: "c", limit: 20, offset: 0 });
    for (let i = 0; i < ticks; i += 1) await Promise.resolve();
    db.exec("DELETE FROM creators");
    const page = await pending;
    expect(page).not.toBeNull();
    const before = { total: 3, creators: 3 };
    const after = { total: 0, creators: 0 };
    expect([before, after]).toContainEqual({ total: page!.total, creators: page!.creators.length });
  });

  it("inserção no meio também não mistura: o total nunca é menor que a página devolvida", async () => {
    for (let ticks = 0; ticks < 7; ticks += 1) {
      const db = database(2);
      const pending = listCreators(db, { campaignId: "c", limit: 20, offset: 0 });
      for (let i = 0; i < ticks; i += 1) await Promise.resolve();
      db.prepare("INSERT INTO creators VALUES (?, ?, ?, ?)").run("novo", "Novo", '["x"]', "{}");
      const page = await pending;
      expect(page!.total, `ticks ${ticks}`).toBe(page!.creators.length);
    }
  });

  it("a leitura consistente continua dentro do teto de 8 queries e a página fora do fim continua com o total certo", async () => {
    const db = database(5);
    resetQueryCount();
    const page = await listCreators(db, { campaignId: "c", limit: 20, offset: 0 });
    expect(getQueryCount()).toBeLessThanOrEqual(8);
    expect(page!.total).toBe(5);
    const past = await listCreators(db, { campaignId: "c", limit: 20, offset: 100 });
    expect(past).toMatchObject({ total: 5, creators: [] });
  });

  it("a leitura não deixa uma transação aberta, nem quando a consulta falha", async () => {
    const db = database(1);
    await listCreators(db, { campaignId: "c", limit: 20, offset: 0 });
    expectNoOpenTransaction(db);
    await expect(listCreators(db, { campaignId: "c", limit: Number.NaN, offset: 0 })).rejects.toThrow();
    expectNoOpenTransaction(db);
  });
});
