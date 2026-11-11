// Trecho representativo (BeautyFlow) — agendamento online sem horário duplicado.
//
// Problema: dois clientes tocam "Reservar" no mesmo horário, ao mesmo tempo, pela agenda
// pública (sem login). Os dois veem o horário livre; sem cuidado, os dois gravam.
//
// Solução em três camadas:
//   1. Trava por LOJA dentro da transação (SELECT ... FOR UPDATE na linha da loja): quem chega
//      depois espera, e ao entrar já enxerga o horário ocupado pelo primeiro.
//   2. Pedido repetido (resposta perdida em sinal fraco + segundo toque) devolve o agendamento
//      já gravado em vez de marcar outro horário.
//   3. Constraint de exclusão no banco como última rede (erro 23P01 vira HTTP 409).
//
// Versão reduzida e sanitizada do código em produção: validações de entrada, sinal via Pix,
// encaixe pelo painel e montagem de links foram omitidos.

async function criarAgendamento(lojaId, body, { agora = new Date() } = {}) {
  const servico = await buscarServicoAtivo(lojaId, body.servicoId); // sempre filtrado por loja_id
  const inicio = arredondarParaMinuto(new Date(body.inicio));
  if (inicio < agora) throw new ErroAgenda(400, 'HORARIO_PASSADO', 'Esse horário já passou.');
  const cli = validarCliente(body); // nome/telefone passam pelo sanitizador de texto

  return db.withTransaction(async (client) => {
    // (1) Serializa por loja. A trava fica na LOJA mesmo com agenda por profissional: é ela
    // que ordena a fila de quem escolheu "qualquer profissional".
    await client.query('SELECT id FROM lojas WHERE id = $1 FOR UPDATE', [lojaId]);

    // (2) Mesmo telefone + nome + serviço + horário há pouco = mesmo pedido.
    const repetido = await client.query(
      `SELECT * FROM agenda_agendamentos
        WHERE loja_id = $1 AND cliente_telefone = $2 AND servico_id = $3 AND inicio = $4
          AND LOWER(cliente_nome) = LOWER($5) AND status <> 'cancelado'
          AND created_at > NOW() - INTERVAL '30 minutes'
        ORDER BY id LIMIT 1`,
      [lojaId, cli.tel, servico.id, inicio, cli.nome]);
    if (repetido.rows[0]) return agendamentoOut(repetido.rows[0]);

    // Quem não escolheu profissional não ouve "ocupado" enquanto alguém da equipe está livre.
    const equipe = await profissionaisAtivos(lojaId, client);
    const candidatos = body.profissionalId
      ? equipe.filter((p) => p.id === Number(body.profissionalId))
      : equipe;
    let escolhido = null;
    for (const p of candidatos) {
      const slots = await slotsDoDia(lojaId, servico, inicio, agora, client, p.id);
      if (slots.some((s) => s.inicio === isoLocal(inicio))) { escolhido = p; break; }
    }
    if (!escolhido) {
      throw new ErroAgenda(409, 'HORARIO_INDISPONIVEL', 'Esse horário acabou de ser ocupado. Escolha outro.');
    }

    const fim = new Date(inicio.getTime() + servico.duracaoMin * 60000);
    const token = crypto.randomBytes(16).toString('hex'); // link de cancelamento do cliente
    try {
      const r = await client.query(
        `INSERT INTO agenda_agendamentos
           (loja_id, servico_id, cliente_nome, cliente_telefone, inicio, fim, status, token, profissional_id)
         VALUES ($1, $2, $3, $4, $5, $6, 'confirmado', $7, $8) RETURNING *`,
        [lojaId, servico.id, cli.nome, cli.tel, inicio, fim, token, escolhido.id]);
      return agendamentoOut(r.rows[0]);
    } catch (e) {
      // (3) Constraint de exclusão (sobreposição de intervalo) como rede final.
      if (e && e.code === '23P01') {
        throw new ErroAgenda(409, 'HORARIO_INDISPONIVEL', 'Esse horário acabou de ser ocupado. Escolha outro.');
      }
      throw e;
    }
  });
}
