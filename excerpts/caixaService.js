// Trecho extraído do BarFlow Cloud (src/caixa/service.js) — imports relativos ao
// repositório completo, privado. Ver README do showcase pro contexto.
const db = require('../db');

// Achado no item 6 do roadmap (30/08/2026, testando isolamento multi-tenant): o "dia de
// operação" misturava hora LOCAL do processo Node (getHours()) com data em UTC do
// Postgres — em produção o Cloud Run roda em UTC, então "hora_corte_dia = 6" (pensado
// pelo lojista como 6h de Brasília) virava na prática 6h UTC = 3h da manhã em Brasília,
// cortando o dia 3h mais cedo do que o dono do bar espera. Todas as lojas são
// brasileiras, então ancoramos tudo em America/Sao_Paulo (UTC-3 fixo, sem horário de
// verão desde 2019 — não precisa de tabela de fuso) em vez do fuso de onde o código roda.
const OFFSET_BRASIL_MS = 3 * 60 * 60 * 1000;

function getDataOperacao(horaCorte = 6, now = new Date()) {
  const localBR = new Date(now.getTime() - OFFSET_BRASIL_MS);
  if (localBR.getUTCHours() < horaCorte) {
    localBR.setUTCDate(localBR.getUTCDate() - 1);
  }
  return localBR.toISOString().split('T')[0];
}

function horaAgoraBrasil() {
  return new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' });
}

async function getHoraCorte(lojaId) {
  const lojaRes = await db.query('SELECT hora_corte_dia FROM lojas WHERE id = $1', [lojaId]);
  return lojaRes.rows.length > 0 ? (lojaRes.rows[0].hora_corte_dia || 6) : 6;
}

// Pedido do dono do Loja Exemplo (30/08/2026, mesma lógica do BarFlow desktop): abrir/fechar
// caixa e as movimentações do dia SEMPRE usam a data de operação calculada pelo próprio
// servidor — nunca uma data que o cliente mande no corpo da requisição. Isso fecha a
// brecha de conseguir lançar/fechar caixa num dia que não é "hoje" de verdade.

async function abrirCaixaDia(lojaId, { saldoInicial, abertoPor }) {
  const horaCorte = await getHoraCorte(lojaId);
  const dataOp = getDataOperacao(horaCorte);

  const existente = await db.query(
    'SELECT * FROM caixa_aberturas WHERE loja_id = $1 AND data_operacao = $2::date',
    [lojaId, dataOp]
  );
  if (existente.rows.length > 0) {
    const err = new Error('Caixa já foi aberto hoje.');
    err.code = 'CAIXA_JA_ABERTO';
    err.abertura = existente.rows[0];
    throw err;
  }

  const ins = await db.query(`
    INSERT INTO caixa_aberturas (loja_id, data_operacao, saldo_inicial, aberto_por)
    VALUES ($1, $2::date, $3, $4)
    RETURNING *
  `, [lojaId, dataOp, parseFloat(saldoInicial) || 0, abertoPor || null]);

  return ins.rows[0];
}

async function getResumoDia(lojaId) {
  const horaCorte = await getHoraCorte(lojaId);
  const dataOp = getDataOperacao(horaCorte);

  // Achado 30/08/2026 (revisão financeira pré-produção): antes contava TODO pedido do dia
  // no faturamento/caixa, mesmo mesa ainda aberta (forma_pagamento = 'A definir', cliente
  // nem pagou ainda — e caía errado dentro de "Pix" por não bater com nenhum filtro) e
  // mesmo pedido cancelado pelo lojista. Caixa só reflete o que já foi de fato fechado/pago.
  const pedidosRes = await db.query(`
    SELECT total, forma_pagamento, status
    FROM pedidos
    WHERE loja_id = $1
      AND (DATE(created_at - INTERVAL '3 hours' - INTERVAL '1 hour' * $2) = $3::date)
      AND status != 'cancelado'
      AND forma_pagamento != 'A definir'
  `, [lojaId, horaCorte, dataOp]);

  let totalPix = 0;
  let totalCredito = 0;
  let totalDebito = 0;
  let totalDinheiro = 0;
  let faturamentoBruto = 0;
  let totalPedidos = pedidosRes.rows.length;

  pedidosRes.rows.forEach(p => {
    const val = parseFloat(p.total) || 0;
    faturamentoBruto += val;
    const pgto = (p.forma_pagamento || '').toLowerCase();
    if (pgto.includes('pix')) totalPix += val;
    else if (pgto.includes('crédito') || pgto.includes('credito')) totalCredito += val;
    else if (pgto.includes('débito') || pgto.includes('debito')) totalDebito += val;
    else if (pgto.includes('dinheiro')) totalDinheiro += val;
    else totalPix += val;
  });

  const movRes = await db.query(`
    SELECT id, tipo, valor, info, created_at
    FROM caixa_movimentacoes
    WHERE loja_id = $1 AND data_operacao = $2::date
    ORDER BY id ASC
  `, [lojaId, dataOp]);

  let totalSuprimentos = 0;
  let totalSangrias = 0;

  movRes.rows.forEach(m => {
    const val = parseFloat(m.valor) || 0;
    if (m.tipo === 'suprimento') totalSuprimentos += val;
    if (m.tipo === 'sangria') totalSangrias += val;
  });

  const aberturaRes = await db.query(
    'SELECT * FROM caixa_aberturas WHERE loja_id = $1 AND data_operacao = $2::date',
    [lojaId, dataOp]
  );
  const abertura = aberturaRes.rows[0] || null;
  const saldoInicial = abertura ? Number(abertura.saldo_inicial) : 0;
  const saldoDinheiroEsperado = saldoInicial + totalDinheiro + totalSuprimentos - totalSangrias;

  const histRes = await db.query(`
    SELECT * FROM historico_dias
    WHERE loja_id = $1 AND data_operacao = $2::date
    ORDER BY id DESC LIMIT 1
  `, [lojaId, dataOp]);

  const fechado = histRes.rows.length > 0;
  const dadosFechamento = fechado ? histRes.rows[0] : null;

  return {
    dataOperacao: dataOp,
    caixaAberto: !!abertura,
    abertura,
    saldoInicial: Number(saldoInicial.toFixed(2)),
    faturamentoBruto: Number(faturamentoBruto.toFixed(2)),
    totalPix: Number(totalPix.toFixed(2)),
    totalCredito: Number(totalCredito.toFixed(2)),
    totalDebito: Number(totalDebito.toFixed(2)),
    totalDinheiro: Number(totalDinheiro.toFixed(2)),
    totalSuprimentos: Number(totalSuprimentos.toFixed(2)),
    totalSangrias: Number(totalSangrias.toFixed(2)),
    saldoDinheiroEsperado: Number(saldoDinheiroEsperado.toFixed(2)),
    totalPedidos,
    movimentacoes: movRes.rows,
    fechado,
    dadosFechamento
  };
}

async function registrarMovimentacao(lojaId, tipo, valor, info) {
  const horaCorte = await getHoraCorte(lojaId);
  const dataOp = getDataOperacao(horaCorte);

  const ins = await db.query(`
    INSERT INTO caixa_movimentacoes (loja_id, tipo, valor, info, data_operacao)
    VALUES ($1, $2, $3, $4, $5::date)
    RETURNING *
  `, [lojaId, tipo, valor, info, dataOp]);

  return ins.rows[0];
}

async function fecharCaixaDia(lojaId, dados) {
  const resumo = await getResumoDia(lojaId);
  const dataOp = resumo.dataOperacao;

  // Achado 30/08/2026: nada impedia fechar o mesmo dia várias vezes seguidas (cada
  // clique criava um historico_dias novo). Agora só deixa fechar uma vez — se
  // fechou errado, usa reabrirCaixaDia() antes de tentar de novo.
  if (resumo.fechado) {
    const err = new Error('Este dia já foi fechado. Reabra o caixa antes de fechar de novo.');
    err.code = 'CAIXA_JA_FECHADO';
    err.fechamento = resumo.dadosFechamento;
    throw err;
  }

  // Saldo inicial vem da abertura de verdade (se o caixa foi aberto hoje); só cai no
  // valor mandado no corpo do fechamento se ninguém abriu o caixa explicitamente —
  // mantém o fluxo funcionando pra quem ainda não usa "Abrir Caixa".
  const saldoInicial = resumo.abertura ? Number(resumo.abertura.saldo_inicial) : (parseFloat(dados.saldoInicial) || 0);
  const saldoDeclarado = parseFloat(dados.saldoDeclarado) || 0;
  const saldoEsperado = saldoInicial + resumo.totalDinheiro + resumo.totalSuprimentos - resumo.totalSangrias;
  const diferencaCaixa = saldoDeclarado - saldoEsperado;
  const obs = dados.obs || '';

  const horaAbertura = resumo.abertura
    ? new Date(resumo.abertura.created_at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' })
    : '08:00';

  const ins = await db.query(`
    INSERT INTO historico_dias (
      loja_id, data_operacao, hora_abertura, hora_fechamento,
      saldo_inicial, total_pix, total_credito, total_debito, total_dinheiro,
      total_suprimentos, total_sangrias, faturamento_bruto, faturamento_liquido,
      saldo_final_esperado, saldo_final_declarado, diferenca_caixa, obs
    )
    VALUES ($1, $2::date, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
    RETURNING *
  `, [
    lojaId, dataOp, horaAbertura, horaAgoraBrasil(),
    saldoInicial, resumo.totalPix, resumo.totalCredito, resumo.totalDebito, resumo.totalDinheiro,
    resumo.totalSuprimentos, resumo.totalSangrias, resumo.faturamentoBruto, resumo.faturamentoBruto,
    saldoEsperado, saldoDeclarado, diferencaCaixa, obs
  ]);

  return ins.rows[0];
}

// Desfaz o ÚLTIMO fechamento do dia de operação atual (nunca de um dia passado — só o
// dia de hoje pode ser reaberto, pra não mexer em fechamento já contabilizado de outro
// dia). Não apaga movimentações/pedidos, só o registro de fechamento em si.
async function reabrirCaixaDia(lojaId) {
  const horaCorte = await getHoraCorte(lojaId);
  const dataOp = getDataOperacao(horaCorte);

  const del = await db.query(
    `DELETE FROM historico_dias
     WHERE id = (
       SELECT id FROM historico_dias WHERE loja_id = $1 AND data_operacao = $2::date ORDER BY id DESC LIMIT 1
     )
     RETURNING *`,
    [lojaId, dataOp]
  );

  return del.rows[0] || null;
}

module.exports = {
  getDataOperacao,
  abrirCaixaDia,
  getResumoDia,
  registrarMovimentacao,
  fecharCaixaDia,
  reabrirCaixaDia
};
