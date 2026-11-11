# Arquitetura

## Um serviço, três produtos

Um único servidor Node.js atende o BarFlow, o BeautyFlow e o FlowPDV. Cada produto responde no próprio endereço (o host da requisição decide qual produto abre), com marca e telas próprias, mas todos compartilham:

- autenticação e permissões por usuário, conferidas no servidor por rota;
- o banco PostgreSQL, com `loja_id` em toda tabela de dados de loja;
- motor de relatórios e de Gestão (DRE, CMV, margem, ponto de equilíbrio, curva ABC);
- impressão (agente ESC/POS que consulta o servidor), Web Push e armazenamento de fotos.

Módulos novos entram atrás de chave de configuração e podem ser ligados para uma loja de cada vez.

## Por que `http` nativo, sem framework

- Quatro dependências de produção: `pg`, `@google-cloud/storage`, `fast-xml-parser` e `qrcode`.
- Imagem pequena e inicialização rápida no Cloud Run.
- Roteamento explícito, com a permissão de cada usuário conferida no servidor por prefixo de rota.
- Frontend em HTML/CSS/JS sem framework, mobile-first; testes de tela montam a página de verdade com jsdom.

## Multi-tenant

- Banco único; isolamento por `loja_id` em toda consulta, nunca por filtro no frontend.
- O id da loja vem da sessão, não do corpo da requisição.
- Testes de ataque fazem login na loja A e tentam ler, editar, apagar e mudar status de dados da loja B ([trecho](../excerpts/multiTenantIsolation.test.js)).
- O verificador do pre-commit varre todo o código procurando tabela de loja lida sem filtrar a loja, entre outros padrões graves.

## Concorrência e dinheiro

- Operações sensíveis abrem transação e travam a linha da loja (`SELECT ... FOR UPDATE`): agenda, caixa e contas de mesa são serializados **por loja**, sem afetar as outras.
- Constraints no banco como última rede (ex.: constraint de exclusão impede dois agendamentos sobrepostos para o mesmo profissional).
- Idempotência em pontos de toque duplo e sinal fraco (lançamento do garçom, reserva na agenda, emissão fiscal pela venda).
- **Invariantes** em SQL somente leitura conferem o estado acumulado (total da conta = soma das linhas, nenhuma conta recebe mais do que vale, caixa do dia fecha consigo mesmo) ([trecho](../excerpts/invariantesConta.js)).

## Migrations

- 268 arquivos SQL (numerados até 332), executados **a cada boot**, escritos para serem idempotentes (`IF NOT EXISTS`, `ON CONFLICT` com constraint real).
- Um ledger registra migrações de dados que só podem rodar uma vez; um advisory lock do PostgreSQL faz as instâncias que sobem juntas no deploy esperarem a primeira terminar.
- Consequência prática: o deploy não tem passo manual de banco, e voltar para a revisão anterior do serviço continua funcionando sobre o banco já migrado.

## Testes e portões de qualidade

- ~4.350 casos de teste em 728 arquivos, rodando com o runner nativo (`node --test`) contra um PostgreSQL real descartável.
- Convenção: cada mudança vira uma "fase" numerada com seus testes; a guarda tem que reprovar sem a correção.
- **Pre-commit:** verificador estático da auditoria (~1 s, sem banco nem rede) que barra o commit em achado grave — vazamento entre lojas, cobrança errada ou algo que derrube a operação.
- **Pre-push:** suíte inteira.
- Registro escrito de cada deploy: revisão, o que mudou e qual revisão é o plano de volta.

## Infraestrutura

- Google Cloud Run (serviço HTTP em contêiner), Cloud SQL (PostgreSQL), Cloud Storage (fotos), Secret Manager (credenciais).
- Tudo roda na nuvem; os dados de cada loja ficam no banco central, isolados por `loja_id`. A única peça local, opcional, é o agente de impressão no PC do caixa.
- A emissão fiscal é um serviço à parte, privado, chamado só para as lojas habilitadas.
