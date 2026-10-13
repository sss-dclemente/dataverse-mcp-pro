# Lista de verificação — 0.4.0

Prepara a etiqueta `v0.4.0`. Não publica, não cria a etiqueta e não corre
`npm publish`. O workflow `.github/workflows/release.yml` publica no npm com
provenance quando alguém faz push de uma etiqueta `v*`. Esse push é um passo
humano, depois do merge e do smoke test, e não faz parte do pull request que
introduz esta lista.

Se a etiqueta sair noutro dia que não 2026-10-13, atualiza a data em
`CHANGELOG.md` antes de etiquetar.

## O que entra na 0.4.0

- `analyze_business_rules`, a 21.ª ferramenta.
- Playbooks de consultor em `docs/consultants.md` (Go-live, Incident, Assessment).
- Descrições das ferramentas a abrir pelo trabalho a que pertencem.
- Correções de honestidade já no ramo: teto de `what_runs_on_table`,
  `get_solution_layers` sem afirmar managed/unmanaged nas camadas de baixo,
  quickstart, e `docs/smoke-test.md` a apontar para o `dist/server.js` deste
  build.
- `docs/roadmap.md`, esta lista, e `.github/dependabot.yml` (semanal, um grupo
  npm e um grupo GitHub Actions).
- A correção do hang de `detect_automation_loops`: a lista já não seleciona
  `clientdata`, cada chamada tem prazo, e o varrimento tem orçamento e limite
  de tamanho. O changelog da 0.4.0 regista-a em Fixed.

## O que não entra

- Qualquer alteração a dvops-docs. É outro repositório.
- `npm publish` a partir de um portátil, e qualquer etiqueta `v*` criada daqui.

## Neste pull request

- [ ] `package.json` e a versão da raiz em `package-lock.json` dizem `0.4.0`.
      A dependência `tinyexec` também usa 0.3.2; essa não se mexe.
- [ ] `CHANGELOG.md` tem `## [0.4.0] - 2026-10-13` com o que está listado acima,
      e `## [Unreleased]` fica vazio.
- [ ] `npm test` e `npm run build` passam.
- [ ] `npm run verify:package` passa: o tarball arranca por stdio e expõe as
      21 ferramentas.
- [ ] O pull request fica aberto. Não se faz merge neste passo.

## Depois do merge, antes da etiqueta

Humano, no commit que vai ser etiquetado. O smoke test está em
[`docs/smoke-test.md`](smoke-test.md).

- [ ] Host apontado a `dist/server.js` deste build, não a
      `npx -y @simplesmoothsafe/dataverse-ops-mcp`. O `npx` corre a última
      versão publicada, que ainda é a 0.3.2 até a etiqueta existir.
- [ ] `ping`, `get_plugin_traces`, `get_flow_runs`, `what_runs_on_table`.
- [ ] Não uses `detect_automation_loops` como passo de smoke.
- [ ] `npm run verify:package` outra vez, no mesmo commit.

## Publicar

Só depois das caixas acima. Continua a ser uma pessoa a fazê-lo.

- [ ] `git tag v0.4.0` no commit mergeado e `git push origin v0.4.0`.
- [ ] O workflow Release faz `npm publish --provenance --access public`. Não
      publiques à mão em paralelo.
- [ ] Confirma o pacote no npm e a proveniência da etiqueta.

## dvops-docs, depois da etiqueta

Leitura em 2026-10-13, sem alterações nesse repositório.

- [ ] `npm run sync` no dvops-docs a partir do commit etiquetado, para as 21
      ferramentas e o changelog da 0.4.0.
- [ ] A landing (`src/pages/index.astro`) já não tem secção de preços nem
      botões Paddle. O README do site ainda descreve essa secção e ainda manda
      substituir `https://buy.paddle.com/PLACEHOLDER_PRO` e `..._ENTERPRISE`.
      Corrige o README. Não voltes a pôr a secção.
- [ ] O changelog do site tem entradas antigas sobre checkout e licença. São o
      passado das versões pagas. Não as apagues; não as apresentes como o
      produto atual.
