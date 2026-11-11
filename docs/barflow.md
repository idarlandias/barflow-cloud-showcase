# BarFlow — bar, restaurante, lanchonete e confeitaria

O BarFlow é a frente original da plataforma: atende o salão, o balcão, a cozinha e o escritório de um estabelecimento de comida. Abaixo, o que o código faz hoje, agrupado por módulo. Tudo é multi-tenant: cada consulta é filtrada pela loja do usuário logado.

## Segmentos

A loja escolhe um segmento (açaiteria, hamburgueria, pizzaria, espetinho, sushi, bar ou confeitaria; sem segmento = genérico). O segmento muda as abas de métricas (hambúrgueres, pizzas, espetos, doses, complementos…), a cor do painel e sugestões como esconder o módulo de garçom em quem não tem salão.

## Cardápio digital e QR de mesa

- Cardápio público mobile-first, com fotos, selos por item e opções obrigatórias (ponto da carne, tipo de queijo etc.).
- Folhas de QR por mesa para imprimir: o cliente pede da mesa pelo celular.
- Adicionais em grupos, com limite de escolhas por tamanho.
- Pizza meio a meio cobrando pelo sabor mais caro; listas de sabores por item.
- Promoções: preço de/por, combos, brindes e agendamento.
- Horário de funcionamento por dia da semana, "fechar agora" e pausa de item (item pausado é recusado com aviso, não some em silêncio).

## Pedidos, mesas e garçom

- App do garçom no celular: mapa de mesas, lançamento na comanda, chamado para a cozinha.
- Pagamento parcial, transferência de itens e junção de contas; taxa de serviço contada como comissão do garçom, que tem a própria tela "Meu Caixa".
- Proteção contra toque duplo no lançamento.
- Totens de autoatendimento ativados pelo gerente com código de uso único.
- Permissões por usuário (pedidos, cardápio, caixa, analytics, margens, estoque, clientes, garçons, configurações, atender mesa, fornecedores), com predefinições para cozinha, garçom e gerente, conferidas no servidor por rota.
- Invariantes da conta (ex.: total = soma das linhas; nenhuma conta recebe mais do que vale) conferidas em modo somente leitura — ver [`excerpts/invariantesConta.js`](../excerpts/invariantesConta.js).

## Cozinha (KDS)

- Fila em tempo real com alerta sonoro, cronômetro por pedido e alerta de atraso.
- Itens que não passam pela cozinha (bebidas) ficam fora da tela.
- Estimativa de fila no cardápio, calculada pelo histórico real da cozinha — existe no código, desligada por padrão.

## Caixa

- Abertura com troco, sangria e suprimento com autor, fechamento com conferência e relatório Z.
- Acrescentar item a pedido ainda não pago, desconto de balcão em % ou R$, correção de forma de pagamento.
- "Dia operacional" com hora de corte por loja, calculado no servidor (bar que fecha às 4h fecha o caixa do dia certo) — ver [`excerpts/caixaService.js`](../excerpts/caixaService.js).

## Estoque e custos

- Ficha técnica por produto: baixa automática a cada venda e estorno quando o pedido é cancelado.
- Custo PEPS, porções e fatias.
- Entrada de compra pelo XML da NF-e do fornecedor ou pela foto do cupom (leitura com IA de visão).
- Histórico de preço de compra, CMV e reajuste de preço sugerido quando o custo sobe.

## Gestão e financeiro

- Aba **Gestão (BI):** DRE gerencial, margem de contribuição, ponto de equilíbrio (contábil, econômico e financeiro), custos fixos × variáveis, previsão do mês, curva ABC, mapa de calor dia × hora e relatório para imprimir em A4.
- Agenda de despesas com contas recorrentes e exportação CSV para o contador.
- Vale de funcionário, fornecedores, aba de relatórios com CSV.

## Clientes, cupons e entrega

- Cadastro de clientes por loja (chave = telefone) e conta do cliente com login Google.
- Mensagem de aniversário opcional (desligada por padrão).
- Taxa de entrega por bairro e frete grátis para quem volta a comprar.
- Entregadores: cadastro, taxa do entregador fora do caixa da loja e acerto ("pagar entregadores") no fechamento.
- Não há programa de fidelidade/cashback.

## Impressão e notificações

- Agente de impressão no PC do caixa (ESC/POS): via da cozinha, do entregador e do cliente.
- Web Push para a loja e para o cliente, implementado sem biblioteca.

## ConfeiteiraFlow

Variação do BarFlow para confeitaria por encomenda:

- Encomendas com data de entrega, sinal e status; o cliente acompanha por link.
- Caixa rápido para feira/evento: pagamento dividido, troco só no dinheiro, comprovante, lucro por evento.
- Receitas com custo por fatia e modelos reutilizáveis.

## Tô com Fome (marketplace)

- Vitrine pública por cidade reunindo as lojas da plataforma, com fase de lançamento definida por cidade e lista de espera.
- Cupons: primeiro pedido, código promocional, frete grátis, cliente que volta.
- Sem comissão por pedido e sem intermediar pagamento: o pedido entra direto no painel da loja.
- Aceite eletrônico dos termos pela loja; plano "Vitrine" para quem só quer aparecer no marketplace.

## Assistente de suporte

- Responde dúvidas do lojista a partir dos manuais oficiais do sistema: busca BM25 nos cartões do manual e, opcionalmente, resumo por LLM (Gemini) com checagem contra alucinação.
- A parte de IA é ligada por configuração.

## WhatsApp

- Confirmação de pedido pelo WhatsApp da loja, aba de conversas no painel e webhook da API oficial. O bot de atendimento em si roda fora deste serviço.

## O que não está aqui

- Integração com iFood e com maquininha de cartão.
- Fidelidade/cashback.

## Planos (tabela de referência no código)

| Plano | R$/mês | Para quem |
|---|---|---|
| Vitrine | 49,90 | Loja que só aparece no marketplace |
| Plus | 69,90 | Cardápio digital, pedidos/KDS, caixa, relatórios, equipe |
| Pro | 99,90 | Plus + mesas/garçom, estoque com ficha técnica, clientes, despesas |
| Ultra | 139,90 | Pro + custos/CMV, NF-e de compra e cupom por foto, fornecedores, Gestão (BI) |
| ConfeiteiraFlow | 49,90 | Confeitaria |
| Evento | definido por evento | Uso pontual em evento |
