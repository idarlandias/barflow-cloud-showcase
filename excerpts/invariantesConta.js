// Trecho representativo (BarFlow) — invariantes da conta da mesa.
//
// Uma invariante é uma frase que tem que ser verdade SEMPRE. Cada uma nasceu de um defeito
// real encontrado em auditoria: se voltar a ser falsa, aquele defeito voltou.
//
// Teste de unidade prova o código de hoje; invariante prova o ESTADO acumulado no banco.
// Por isso elas rodam periodicamente contra a base, em transação SET TRANSACTION READ ONLY
// (nem um UPDATE acidental num refactor futuro conseguiria gravar), e o resultado sai
// agrupado por loja, com quantidade de violações, valor envolvido e alguns ids de exemplo.
//
// O sistema tem dez invariantes (I1–I10). Abaixo, três delas, sem alteração de lógica.

// I1 — o total da conta é a soma das linhas dela.
//   Falso quando: item some da conta sem recalcular o total, ou o total é reescrito por fora.
//   Comanda 'juntada' fica de fora: ela zera o total por desenho.
const I1 = `
  SELECT c.loja_id, COUNT(*)::int AS violacoes, ROUND(SUM(ABS(c.total::numeric - s.soma)), 2) AS valor,
         (ARRAY_AGG(c.id ORDER BY c.updated_at DESC))[1:5] AS exemplos
  FROM comandas c
  JOIN LATERAL (
    SELECT COALESCE(SUM(ci.preco_unitario::numeric * ci.quantidade), 0) AS soma
    FROM comanda_itens ci WHERE ci.comanda_id = c.id AND ci.loja_id = c.loja_id
  ) s ON true
  WHERE c.status IN ('aberta', 'fechando', 'fechada')
    AND c.updated_at >= NOW() - INTERVAL '1 day' * $1
    AND ABS(c.total::numeric - s.soma) > 0.01
  GROUP BY c.loja_id`;

// I4 — pedido cancelado não ressuscita.
//   Janela própria de 30 dias: ressurreição é rara e cara.
const I4 = `
  SELECT p.loja_id, COUNT(*)::int AS violacoes, ROUND(SUM(p.total::numeric), 2) AS valor,
         (ARRAY_AGG(p.id ORDER BY p.id DESC))[1:5] AS exemplos
  FROM pedidos p
  WHERE p.cancelado_em IS NOT NULL AND p.status <> 'cancelado'
    AND p.cancelado_em >= NOW() - INTERVAL '30 days'
  GROUP BY p.loja_id`;

// I8 — nenhuma conta recebe mais do que vale.
//   Nasceu de uma corrida real: dois pagamentos parciais simultâneos somaram mais do que a
//   conta. Soma tudo que entrou (parciais + fechamento) e compara com consumo + serviço + couvert.
const I8 = `
  SELECT c.loja_id, COUNT(*)::int AS violacoes,
         ROUND(SUM(p.pago - (COALESCE(c.total, 0)::numeric + COALESCE(c.taxa_servico_valor, 0)::numeric
                             + COALESCE(c.couvert_valor, 0)::numeric)), 2) AS valor,
         (ARRAY_AGG(c.id ORDER BY c.updated_at DESC))[1:5] AS exemplos
  FROM comandas c
  JOIN LATERAL (
    SELECT COALESCE(SUM(cp.valor::numeric), 0) AS pago
    FROM comanda_pagamentos cp WHERE cp.comanda_id = c.id AND cp.loja_id = c.loja_id
  ) p ON true
  WHERE c.status IN ('aberta', 'fechando', 'fechada')
    AND c.updated_at >= NOW() - INTERVAL '1 day' * $1
    AND p.pago > COALESCE(c.total, 0)::numeric + COALESCE(c.taxa_servico_valor, 0)::numeric
                 + COALESCE(c.couvert_valor, 0)::numeric + 0.01
  GROUP BY c.loja_id`;

// Execução (resumida): cada consulta roda numa transação somente leitura e o resultado é
// distribuído por loja. Loja desativada não some do TOTAL — silenciar uma violação porque
// a loja foi desativada seria esconder dinheiro.
async function rodarInvariantes(client, { janelaDias = 1 } = {}) {
  await client.query('SET TRANSACTION READ ONLY');
  let totalViolacoes = 0;
  const porLoja = new Map();
  for (const { nome, sql, usaJanela } of [
    { nome: 'i1', sql: I1, usaJanela: true },
    { nome: 'i4', sql: I4, usaJanela: false },
    { nome: 'i8', sql: I8, usaJanela: true },
  ]) {
    const r = await client.query(sql, usaJanela ? [janelaDias] : []);
    for (const linha of r.rows) {
      totalViolacoes += Number(linha.violacoes) || 0;
      const atual = porLoja.get(linha.loja_id) || {};
      atual[nome] = { violacoes: linha.violacoes, valor: linha.valor, exemplos: linha.exemplos };
      porLoja.set(linha.loja_id, atual);
    }
  }
  return { totalViolacoes, porLoja };
}

module.exports = { rodarInvariantes };
