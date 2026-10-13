# Roteiro — Dataverse Ops MCP

De Q4 2026 a 2027. Fontes: README, `CLAUDE.md`, CHANGELOG, commits e o site
[dvops-docs](https://github.com/sss-dclemente/dvops-docs), revisto em 2026-10-13.
O que estava marcado como inferido no rascunho e foi confirmado ou corrigido
nessa leitura fica dito em concreto.

## Estado atual

- Servidor MCP em código aberto (MIT, grátis, sem licença nem telemetria), stdio,
  só leitura (GET e `$batch` de GET) sobre a Web API v9.2.
- npm `@simplesmoothsafe/dataverse-ops-mcp`. A versão publicada é a **0.3.2**
  (2026-08-25), com provenance em etiquetas `v*`. A **0.4.0** está preparada
  neste ramo e não está publicada.
- 21 ferramentas. `analyze_business_rules` e os playbooks de consultor entram
  na 0.4.0.
- Playbooks de consultor (Go-live / Incident / Assessment) em `docs/consultants.md`.
- `detect_automation_loops` excedeu o tempo (840 s) numa org com um único cloud
  flow activado. A 0.4.0 inclui a correção: prazo por pedido, orçamento do
  varrimento, limite de tamanho, sem seguir `@odata.nextLink`. A causa no
  servidor Dataverse continua por reproduzir: o CI só usa fixtures.
- Documentação e landing em **dvops-docs** (Astro + Starlight). Último commit
  em 2026-07-11 (`Add draft launch posts`). Ver [o que o site ainda diz sobre
  preços](#dvops-docs-e-a-secção-de-preços).
- `licensing-worker` é só referência histórica. Não há gate de licença neste
  servidor.

## dvops-docs e a secção de preços

Leitura só de leitura do repositório `sss-dclemente/dvops-docs` em 2026-10-13,
sem alterações.

A landing (`src/pages/index.astro`) **já não tem secção de preços**. As secções
são navegação, hero, matriz de ferramentas, open source e rodapé. O texto diz
que as ferramentas são grátis e estão sob a licença MIT. Não há botões Paddle
no fonte da página.

O README desse repositório **ainda descreve** a página `/` como tendo pricing e
ainda manda substituir placeholders `https://buy.paddle.com/PLACEHOLDER_PRO` e
`..._ENTERPRISE` em `src/pages/index.astro`. Esses URLs não estão na página. O
changelog do site conserva entradas antigas sobre checkout e licença, no passado,
nas versões em que o produto era pago.

O site está atrás do servidor: 20 páginas de ferramentas, sem
`analyze_business_rules`, changelog parado antes da 0.4.0.

## Objetivos

1. Q4 2026: publicar a 0.4.0 com o que está no CHANGELOG dessa versão, incluindo
   a correção do hang de `detect_automation_loops`.
2. 2027: ser a ferramenta de diagnóstico que um consultor Dataverse abre
   primeiro, e o sítio por onde esses contactos chegam aos serviços da SSS.

## Agora (Q4 2026)

- **E1 — Release 0.4.0.** `analyze_business_rules`, playbooks, descrições por
  trabalho. Lista em `docs/release-checklist.md`. Sem publicar a partir do PR.
- **E2 — `detect_automation_loops`.** Na 0.4.0: prazo, limite de tamanho e a
  forma da query (lista sem `clientdata`, definição por id). Sem algoritmo novo.
  O varrimento deixa de esperar até o host desistir; falta vê-lo a voltar numa
  org real.
- **E3 — dvops-docs.** Tirar do README a secção de preços e os placeholders
  Paddle, que já não existem na landing. Sincronizar as 21 ferramentas e o
  changelog. Trabalho noutro repositório.

## A seguir (Q1–Q2 2027)

- **E4 — Smoke tests live** recorrentes contra uma org de teste. Hoje o CI só
  usa fixtures.
- **E5 — Distribuição.** Registos MCP e marketplaces dos hosts.
- **E6 — Interoperação com o Microsoft Dataverse MCP.** Documentar o setup
  conjunto. Os dois servidores fazem trabalhos diferentes.

## Mais tarde (H2 2027)

- **E7 — Ciclos plugin↔flow.** Hoje estão fora de âmbito.
- **E8 — Partilhar núcleo com sss-pptb.** A mesma lógica de dependências e de
  solution layers.
- **E9 — 1.0** com a API das ferramentas estável.

## Dependências

- `@modelcontextprotocol/sdk`, `zod`, `@azure/identity`. Node 20+.
- Hosts MCP (Claude, Grok, e outros).
- dvops-docs. O site da SSS para descoberta.

## Riscos

- A Microsoft alargar o MCP oficial ao diagnóstico, e este servidor deixar de
  se distinguir.
- Uma ferramenta que pendura numa demo prejudica a reputação. O banimento em
  demos e triagem mantém-se até um org real mostrar que o varrimento com prazo
  volta.
- Projeto grátis, sem receita direta. O valor é indireto: quem o usa numa
  org a sério é um possível cliente de consultoria.

## Perguntas em aberto

1. Quando sai a etiqueta `v0.4.0`?
2. O repositório deve passar a chamar-se `dataverse-ops-mcp`? O "pro" deixou de
   corresponder ao produto quando as licenças saíram.
3. dvops-docs fica como site separado ou entra no simplesmoothsafe.com?
4. Que métrica de sucesso conta: downloads no npm, contactos de consultoria, ou
   as duas?
