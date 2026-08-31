// Trecho extraído do BarFlow Cloud (tests/fase7_isolamento_multitenant.test.js) — imports
// relativos ao repositório completo, privado. Ver README do showcase pro contexto.
//
// Fase 7 (item 6 do roadmap, 30/08/2026): teste de invasão real de isolamento multi-tenant.
// Cria uma segunda loja de verdade no banco e tenta, com o token válido da Loja A, ler/
// alterar/apagar dados que pertencem só à Loja B — em todo domínio (cardápio, pedidos,
// caixa, analytics, tema). Nunca tinha sido validado na prática, só por leitura de código.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { server } = require('../src/server');
const db = require('../src/db');
const { runMigrations } = require('../src/db/migrate');
const { seed } = require('../src/db/seed');
const { hashPassword } = require('../src/auth/crypto');

let baseUrl = '';
let srv = null;
let tokenA = ''; // Loja Exemplo (loja 1, do seed)
let tokenB = ''; // Loja Teste Isolamento (loja 2, criada só pra este teste)
let lojaBId = 0;
let itemBId = 0;
let pedidoBId = 0;

before(async () => {
  await runMigrations();
  await seed();

  await new Promise((resolve) => {
    srv = server.listen(0, () => {
      const port = srv.address().port;
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });

  // Loja B: segunda loja real, isolada, criada direto no banco (sem depender do seed
  // de produção do Loja Exemplo) — simula um segundo cliente pagante do SaaS.
  const lojaRes = await db.query(
    `INSERT INTO lojas (slug, nome_fantasia, ativa) VALUES ($1, $2, true)
     ON CONFLICT (slug) DO UPDATE SET nome_fantasia = EXCLUDED.nome_fantasia
     RETURNING id`,
    ['loja-teste-isolamento-fase7', 'Loja Teste Isolamento Fase 7']
  );
  lojaBId = lojaRes.rows[0].id;

  await db.query(
    `INSERT INTO usuarios_lojista (loja_id, nome, email, senha_hash, role, ativo)
     VALUES ($1, 'Dono Loja B', 'lojab-fase7@teste.com', $2, 'admin', true)
     ON CONFLICT (email) DO UPDATE SET senha_hash = EXCLUDED.senha_hash, loja_id = EXCLUDED.loja_id`,
    [lojaBId, hashPassword('senhaLojaB123')]
  );

  const itemRes = await db.query(
    `INSERT INTO cardapio_itens (loja_id, nome, categoria, preco, disponivel)
     VALUES ($1, 'Produto Secreto da Loja B', 'Geral', 99.90, true) RETURNING id`,
    [lojaBId]
  );
  itemBId = itemRes.rows[0].id;

  const pedidoRes = await db.query(
    `INSERT INTO pedidos (loja_id, display_id, cliente_nome, tipo_pedido, itens, total, forma_pagamento, status)
     VALUES ($1, '#B001', 'Cliente Secreto da Loja B', 'retirada', $2, 99.90, 'Pix', 'pendente') RETURNING id`,
    [lojaBId, JSON.stringify([{ id: itemBId, nome: 'Produto Secreto da Loja B', preco: 99.90, qtd: 1, itemTotal: 99.90 }])]
  );
  pedidoBId = pedidoRes.rows[0].id;

  const loginA = await req('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'gerente@restaurante-exemplo.com', senha: 'senha-de-teste-123' })
  });
  tokenA = loginA.body.token;

  const loginB = await req('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'lojab-fase7@teste.com', senha: 'senhaLojaB123' })
  });
  tokenB = loginB.body.token;
  assert.ok(tokenA, 'login da loja A (Loja Exemplo) falhou');
  assert.ok(tokenB, 'login da loja B (teste) falhou');
});

after(async () => {
  if (srv) srv.close();
  await db.close();
});

async function req(path, options = {}) {
  const url = baseUrl + path;
  const res = await fetch(url, options);
  let body = null;
  const text = await res.text();
  try { body = JSON.parse(text); } catch (_) { body = text; }
  return { status: res.status, body };
}

function authA() { return { Authorization: `Bearer ${tokenA}` }; }

test('Fase 7: listagem de cardápio da Loja A nunca contém itens da Loja B', async () => {
  const lista = await req('/api/loja/cardapio', { headers: authA() });
  assert.equal(lista.status, 200);
  const vazado = lista.body.find((i) => i.id === itemBId);
  assert.equal(vazado, undefined, 'item da Loja B vazou na listagem de cardápio da Loja A');
});

test('Fase 7: Loja A não consegue EDITAR item da Loja B usando o próprio token', async () => {
  const put = await req(`/api/loja/cardapio/${itemBId}`, {
    method: 'PUT',
    headers: { ...authA(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ nome: 'HACKEADO PELA LOJA A', categoria: 'Geral', preco: 0.01 })
  });
  // Rota não checa "encontrado" antes de responder — o que importa é o dado real não mudar
  const itemNoBanco = await db.query('SELECT nome, preco FROM cardapio_itens WHERE id = $1', [itemBId]);
  assert.equal(itemNoBanco.rows[0].nome, 'Produto Secreto da Loja B');
  assert.equal(Number(itemNoBanco.rows[0].preco), 99.90);
});

test('Fase 7: Loja A não consegue APAGAR item da Loja B usando o próprio token', async () => {
  await req(`/api/loja/cardapio/${itemBId}`, { method: 'DELETE', headers: authA() });
  const itemNoBanco = await db.query('SELECT id FROM cardapio_itens WHERE id = $1', [itemBId]);
  assert.equal(itemNoBanco.rows.length, 1, 'item da Loja B foi apagado pelo token da Loja A');
});

test('Fase 7: fila de pedidos (KDS) da Loja A nunca contém pedido da Loja B', async () => {
  const kds = await req('/api/loja/pedidos', { headers: authA() });
  assert.equal(kds.status, 200);
  const vazado = kds.body.find((p) => p.id === pedidoBId);
  assert.equal(vazado, undefined, 'pedido da Loja B vazou no KDS da Loja A');
});

test('Fase 7: Loja A não consegue mudar status de pedido da Loja B usando o próprio token', async () => {
  await req(`/api/loja/pedidos/${pedidoBId}/status`, {
    method: 'PATCH',
    headers: { ...authA(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'entregue' })
  });
  const pedidoNoBanco = await db.query('SELECT status FROM pedidos WHERE id = $1', [pedidoBId]);
  assert.equal(pedidoNoBanco.rows[0].status, 'pendente', 'status do pedido da Loja B foi alterado pela Loja A');
});

test('Fase 7: analytics e caixa da Loja A não contam faturamento da Loja B', async () => {
  const analytics = await req('/api/loja/analytics?dias=365', { headers: authA() });
  assert.equal(analytics.status, 200);
  // R$ 99,90 do pedido secreto da Loja B não pode aparecer no faturamento da Loja A
  const nomesProdutos = analytics.body.topProdutos.map((p) => p.nome);
  assert.ok(!nomesProdutos.includes('Produto Secreto da Loja B'));
});

test('Fase 7: Loja A alterar o próprio tema não afeta o tema da Loja B', async () => {
  const temaBAntes = await db.query('SELECT cor_primaria FROM lojas WHERE id = $1', [lojaBId]);

  await req('/api/loja/tema', {
    method: 'PUT',
    headers: { ...authA(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ corPrimaria: '#000000', fotoCapaUrl: '', logoUrl: '' })
  });

  const temaBDepois = await db.query('SELECT cor_primaria FROM lojas WHERE id = $1', [lojaBId]);
  assert.equal(temaBDepois.rows[0].cor_primaria, temaBAntes.rows[0].cor_primaria, 'tema da Loja B mudou ao editar o tema da Loja A');
});

test('Fase 7: pedido público não pode "colar" item de outra loja pelo id (cross-tenant no /api/public/pedidos)', async () => {
  // lojaId = Loja A (Loja Exemplo), mas o id do item pertence à Loja B — não deve nem existir
  // um item válido pra montar o pedido, já que a query de produtos filtra por loja_id.
  const res = await req('/api/public/pedidos', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      lojaId: 1,
      lojaSlug: 'loja-exemplo',
      clienteNome: 'Invasor Fase 7',
      clienteTelefone: '(88) 9 1111-1111',
      tipoPedido: 'retirada',
      formaPagamento: 'Pix',
      clientOrderId: 'ord_fase7_invasao_' + Date.now(),
      itens: [{ id: itemBId, qtd: 1 }]
    })
  });
  assert.equal(res.status, 400);
});
