import { describe, expect, it } from "vitest";
import { openDatabase } from "../src/db.ts";
import { listCreators } from "../src/list-creators.ts";

const MAX_SAFE = Number.MAX_SAFE_INTEGER; // 9.007.199.254.740.991

/** Cada criador tem uma conta por valor de views (uma métrica por conta). */
function database(creators: Record<string, number[]>) {
  const db = openDatabase(":memory:");
  db.prepare("INSERT INTO campaigns VALUES (?, ?, ?)").run("c", "Campanha", '["x"]');
  let account = 0;
  for (const [id, views] of Object.entries(creators)) {
    db.prepare("INSERT INTO creators VALUES (?, ?, ?, ?)").run(id, `Criador ${id}`, '["x"]', "{}");
    for (const v of views) {
      account += 1;
      db.prepare("INSERT INTO social_accounts VALUES (?, ?, ?)").run(`acc${account}`, id, "instagram");
      db.prepare("INSERT INTO metrics VALUES (?, ?, ?, ?, ?)").run(`m${account}`, `acc${account}`, v, "2026-06-01T00:00:00.000Z", "{}");
    }
  }
  return db;
}

describe("agregados acima de 2^53 não derrubam a listagem", () => {
  it("duas contas individualmente seguras que somam além do inteiro seguro: 200, não 500", async () => {
    const db = database({ a: [9_000_000_000_000_000, 9_000_000_000_000_000] });
    const page = await listCreators(db, { campaignId: "c", limit: 20, offset: 0 });
    expect(page).not.toBeNull();
    expect(page!.creators[0]).toMatchObject({ id: "a", latest_reach: 18_000_000_000_000_000 });
    expect(page!.total).toBe(1);
  });

  it("o valor devolvido é o número mais próximo da soma exata (o mesmo que a soma em JavaScript dá nesse caso)", async () => {
    const db = database({ a: [MAX_SAFE, 2] }); // soma exata 9.007.199.254.740.993, que não existe como número
    const page = await listCreators(db, { campaignId: "c", limit: 20, offset: 0 });
    expect(page!.creators[0]!.latest_reach).toBe(MAX_SAFE + 2); // 9.007.199.254.740.992 em ponto flutuante
    expect(page!.creators[0]!.latest_reach).toBe(Number(9_007_199_254_740_993n));
  });

  it("a ordem usa a soma exata: dois alcances que viram o mesmo número ainda ficam em ordem de verdade", async () => {
    // a: 9.007.199.254.740.992 e b: 9.007.199.254.740.993 são o mesmo número em ponto flutuante; por id, "a" viria antes.
    const db = database({ a: [MAX_SAFE, 1], b: [MAX_SAFE, 2] });
    const page = await listCreators(db, { campaignId: "c", limit: 20, offset: 0 });
    expect(page!.creators.map((c) => c.id)).toEqual(["b", "a"]);
    expect(page!.creators[0]!.latest_reach).toBe(page!.creators[1]!.latest_reach); // mesmo número no JSON
  });

  it("alcance pequeno continua exato e a paginação não muda", async () => {
    const db = database({ a: [100, 50], b: [120], c: [10] });
    const page = await listCreators(db, { campaignId: "c", limit: 2, offset: 0 });
    expect(page!.total).toBe(3);
    expect(page!.creators.map((c) => [c.id, c.latest_reach])).toEqual([["a", 150], ["b", 120]]);
    const next = await listCreators(db, { campaignId: "c", limit: 2, offset: 2 });
    expect(next!.creators.map((c) => c.id)).toEqual(["c"]);
  });

  describe("acima de 64 bits (o SUM do SQLite estoura)", () => {
    const MAX = MAX_SAFE;
    const many = (n: number, value = MAX, last = value) => Array.from({ length: n }, (_, i) => (i === n - 1 ? last : value));

    it("1.025 contas de valores individualmente seguros somam mais que 2^63: 200, e o valor é o número mais próximo da soma exata", async () => {
      const db = database({ a: many(1025) });
      const page = await listCreators(db, { campaignId: "c", limit: 20, offset: 0 });
      expect(page).not.toBeNull();
      expect(page!.creators[0]!.latest_reach).toBe(Number(BigInt(MAX) * 1025n));
      expect(page!.total).toBe(1);
    });

    it("a ordem continua exata: a soma maior por UMA unidade, acima de 64 bits, vem primeiro, mesmo com o id pior", async () => {
      const db = database({ a: many(1025, MAX, MAX - 1), b: many(1025) }); // b = a + 1; por id, "a" viria antes
      const page = await listCreators(db, { campaignId: "c", limit: 20, offset: 0 });
      expect(page!.creators.map((c) => c.id)).toEqual(["b", "a"]);
      expect(page!.creators[0]!.latest_reach).toBe(page!.creators[1]!.latest_reach); // o mesmo número no JSON
    });

    it("o desempate por id continua sendo o do JavaScript quando as somas exatas são iguais", async () => {
      const db = database({ b: many(1025), a: many(1025), "\u{10000}": many(1025), "\uffff": many(1025) });
      const page = await listCreators(db, { campaignId: "c", limit: 20, offset: 0 });
      expect(page!.creators.map((c) => c.id)).toEqual(["a", "b", "\uffff", "\u{10000}"].sort()); // unidades UTF-16, como no original
    });

    it("a paginação e o total continuam coerentes com somas gigantes", async () => {
      const db = database({ a: many(1025), b: many(1025, MAX, 5), c: [10] });
      const first = await listCreators(db, { campaignId: "c", limit: 1, offset: 0 });
      const second = await listCreators(db, { campaignId: "c", limit: 1, offset: 1 });
      const third = await listCreators(db, { campaignId: "c", limit: 1, offset: 2 });
      expect([first, second, third].map((p) => p!.creators[0]!.id)).toEqual(["a", "b", "c"]);
      expect(first!.total).toBe(3);
    });
  });

  describe("valores com sinal misto e REAL (fora do domínio de contagem, mas o schema os aceita)", () => {
    const P = 4294967296;

    it("soma com sinais misturados ordena pela soma exata: [2^32, -5] (soma 2^32 - 5) fica atrás de [2^32 - 3]", async () => {
      const db = database({ x: [P, -5], y: [P - 3] });
      const page = await listCreators(db, { campaignId: "c", limit: 20, offset: 0 });
      expect(page!.creators.map((c) => [c.id, c.latest_reach])).toEqual([["y", P - 3], ["x", P - 5]]);
    });

    it("somas iguais com decomposições diferentes empatam e desempatam por id", async () => {
      const db = database({ x: [P, -1], a: [P - 1] });
      const page = await listCreators(db, { campaignId: "c", limit: 20, offset: 0 });
      expect(page!.creators.map((c) => c.id)).toEqual(["a", "x"]);
    });

    it("soma negativa também ordena certo", async () => {
      const db = database({ a: [-P, 3], b: [-P + 3] });
      const page = await listCreators(db, { campaignId: "c", limit: 20, offset: 0 });
      expect(page!.creators.map((c) => c.id)).toEqual(["a", "b"]);
      expect(page!.creators[0]!.latest_reach).toBe(-P + 3);
    });

    it("valor REAL (1,5) não derruba a listagem: é lido como inteiro (truncado), e a resposta é 200", async () => {
      const db = database({ a: [1] });
      db.prepare("UPDATE metrics SET views = 1.5").run();
      const page = await listCreators(db, { campaignId: "c", limit: 20, offset: 0 });
      expect(page!.creators[0]!.latest_reach).toBe(1);
    });
  });

  it("contra um oráculo em BigInt: 300 conjuntos pseudoaleatórios (semente fixa) com valores até 2^53, sinais mistos, empates e somas acima de 64 bits", async () => {
    let state = 123456789;
    const next = () => {
      state = (Math.imul(state, 1103515245) + 12345) >>> 0;
      return state / 4294967296;
    };
    const value = () => {
      const kind = next();
      if (kind < 0.25) return 0;
      if (kind < 0.5) return Math.floor(next() * 100) - 50;
      if (kind < 0.75) return Math.floor(next() * 2 ** 33) - 2 ** 32;
      return (next() < 0.3 ? -1 : 1) * Math.floor(next() * Number.MAX_SAFE_INTEGER);
    };
    for (let round = 0; round < 300; round += 1) {
      const creators: Record<string, number[]> = {};
      const count = 2 + Math.floor(next() * 4);
      for (let k = 0; k < count; k += 1) {
        const accounts = 1 + Math.floor(next() * (round % 10 === 0 ? 1100 : 6));
        creators[`c${k}`] = Array.from({ length: accounts }, value);
      }
      if (round % 3 === 0) creators.dup = [...creators.c0!]; // soma exatamente igual: desempate por id
      const db = database(creators);
      const page = await listCreators(db, { campaignId: "c", limit: 50, offset: 0 });
      const expected = Object.entries(creators)
        .map(([id, views]) => ({ id, sum: views.reduce((s, v) => s + BigInt(v), 0n) }))
        .sort((a, b) => (a.sum === b.sum ? (a.id < b.id ? -1 : 1) : a.sum > b.sum ? -1 : 1));
      expect(page!.creators.map((c) => c.id), `rodada ${round}`).toEqual(expected.map((e) => e.id));
      expect(page!.creators.map((c) => c.latest_reach), `rodada ${round}`).toEqual(expected.map((e) => Number(e.sum)));
    }
  }, 60_000);
});
