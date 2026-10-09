# Complemento da solução (segunda rodada)

A primeira versão desta solução (3 queries, p95 ≈ 12 ms contra ≈ 557 ms da original) já cumpria o contrato. Esta rodada acrescenta dois ajustes, ambos vindos de uma auditoria independente e verificados de novo antes de entrar:

1. **Consultas indexadas e entregas contadas só para a página.** A métrica mais recente de cada conta passa a ser lida por subconsulta indexada (em vez de ranquear todas as métricas com `ROW_NUMBER()`), e `deliveries_90d` é calculado apenas para os criadores da página, depois do `LIMIT/OFFSET`. Três índices direcionados em `src/db.ts`: `social_accounts (creator_id, id)`, `metrics (account_id, captured_at DESC, id DESC, views)` e `deliveries (creator_id, delivered_at)`.
2. **Desempate por `id` igual ao do JavaScript.** O SQLite compara texto por bytes UTF-8 e o JavaScript, por unidades UTF-16, então `""` e `"\u{10000}"` saem em ordens diferentes. Uma função SQLite determinística (`js_string_key`, em `src/db.ts`) gera a chave UTF-16 big endian, usada antes do `LIMIT` e na ordem final. Isso fecha a ressalva sobre ids não ASCII que a versão anterior declarava.

## Quem fez o quê

O patch desta rodada foi escrito e revisado pelo Codex. Eu (Claude Code) o apliquei, rodei de novo os testes e o benchmark, apliquei mutação manual no SQL novo e acrescentei um teste que ele não tinha (ids Unicode dentro de uma página com mais de um criador). **A revisão humana do Dante ainda não foi feita**; a checklist no corpo do PR continua desmarcada.

## Verificação

- `npm test`: 30/30 (20 anteriores + 10 de consistência) e `npm run typecheck` limpo em Node 22.15.0 e em 24.7.0. Os testes originais, `fixtures/page-1.json` e `src/app.ts` não mudaram.
- O teste Unicode falha contra o código anterior e passa com o novo. A mutação manual no SQL (ordem, desempate da métrica, limite dos 90 dias, `OFFSET`, score zero, função UTF-16, ordem final da página) foi pega pelos testes, com uma exceção equivalente na prática: remover o `m.id DESC` da métrica não falha, porque o índice `metrics_latest` já entrega nessa ordem. Mantive o `id DESC` explícito no SQL para a regra não depender do plano de execução.
- Benchmark (`npm run bench`, seed 2000/7, Node 24.7, 5 execuções cada, mesma máquina): 3 queries nos dois casos; p95 de **13,8 a 24,4 ms antes** e de **6,1 a 10,9 ms depois**. A auditoria mediu 13,2 → 6,6 ms. É ruidoso e local: serve como ordem de grandeza, não como garantia. Os índices também aceleram o oráculo de teste, então parte da diferença não é só do SQL novo.

## Página e total do mesmo estado

A listagem fazia três consultas separadas por `await`: campanha, página e total. Com uma escrita no meio (por exemplo, um criador excluído depois da consulta da página e antes da do total) a resposta saía com `total: 0` e um criador na página. Num banco parado isso não aparece, por isso o oráculo de equivalência não pega. Agora as três leituras rodam numa função síncrona dentro de um `BEGIN`/`COMMIT` (`readSnapshot` em `src/db.ts`): nenhum outro tratador da mesma conexão roda no meio e, em arquivo com WAL, quem escreve por outra conexão também não é visto no meio. A função não contém `await`, para a transação nunca ficar aberta por cima de espera nem de rede. Continuam 3 queries (teto de 8), a ordenação UTF-16 e o score com multiplicidade. `test/consistency.test.ts` roda um escritor em sete pontos diferentes da listagem (apagando e inserindo) e exige que a resposta seja inteira do estado anterior ou do posterior; contra o código anterior ele falha. Bench depois da mudança: 3 queries, p95 5,3 ms (uma execução, mesma máquina).

## Riscos

- Os índices mudam o schema em `src/db.ts`; `CREATE INDEX IF NOT EXISTS` é idempotente, mas bancos grandes pagam o custo de criá-los na primeira abertura.
- `db.function` exige Node 22.13+ (no 22.15 e no 24.7 funciona; não testei versões anteriores).
- Não rodei contra volumes de produção.
