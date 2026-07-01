# PROMPT PARA O CLAUDE DESIGN

Você é um diretor de arte e narrativa de nível enterprise. Sua missão é criar uma **apresentação (deck) de vendas que IMPRESSIONE na primeira olhada** — o tipo de deck que um diretor de RH de multinacional aprova sem pedir uma segunda versão. Tom: **premium, sóbrio, humano, com gravitas de produto financeiro e calor de plataforma de bem-estar**. Emoção a evocar: da tensão silenciosa do burnout invisível → ao alívio de finalmente ter um sinal precoce → à confiança de que isto é ético, legal e defensável. Nada de vigilância, nada de alarme; tudo de **cuidado com autoridade**.

---

## 1. PAPEL E OBJETIVO

Crie um **deck de 15 slides + 1 apêndice** (PT-BR) para a plataforma **INTERHUMAN WELLBEING** — uma plataforma de **bem-estar ocupacional e prevenção de burnout**. Público comprador: **diretoria de RH / People / SST e C-level** de médias e grandes empresas brasileiras. O deck deve vender valor para o RH SEM jamais soar como monitoramento. Cada slide carrega **uma ideia**, com um dado-herói ou visual-herói. Densidade baixa, impacto alto.

**Regra inegociável de honestidade técnica** (deve permear TODO o deck): separe visualmente **SINAL-BRUTO** (o que a API de fato retorna) de **INFERÊNCIA-DERIVADA** (leituras de bem-estar que construímos por cima, de forma agregada e longitudinal). A ferramenta **não** mede burnout nem saúde mental clínica — mede **sinais sociais observáveis** em janelas curtas. Vender como "sinal precoce agregado de tendência de energia/engajamento/estresse" é o enquadramento correto e defensável.

---

## 2. CONTEXTO DO PRODUTO (pitch em 3 linhas + diferencial)

**O produto:** um agente leve instalado no PC de cada colaborador, **estritamente opt-in**, que **a cada 1 hora abre a câmera por poucos segundos**, roda inferência de estado humano **100% localmente (on-device)** e reporta ao RH **apenas sinais agregados e anonimizados por time**. O colaborador **vê o próprio dado ANTES do RH**. O vídeo/áudio bruto **NUNCA sai do dispositivo**.

**A tecnologia real (ancore tudo nisto):** pipeline webcam+voz → chunks WebM ~3s → inferência **multimodal em tempo real** (micro-expressão facial + prosódia + linguagem), processável on-device. A API entrega:
- **CAMADA 1 — 12 sinais sociais**, cada um com probabilidade low/medium/high + racional textual + timestamps: engagement, interest, agreement, confidence, confusion, hesitation, uncertainty, skepticism, disagreement, frustration, stress, disengagement.
- **CAMADA 2 — Engagement State** contínuo (engaged / neutral / disengaged, % do tempo + timeline).
- **CAMADA 3 — Conversation Quality Index (CQI)** 0–100 em 5 dimensões: clarity, authority, energy, rapport, learning.
- **CAMADA 4 — métricas derivadas** por sessão: top_signals com avg_intensity, avg_audio_activity, hour_local/time_of_day, per_question, raw_signal_count.

**O diferencial (3 eixos):**
1. **Instrumentação impossível para humanos:** um sinal contínuo e precoce de energia/engajamento/estresse por time — onde hoje o RH só tem uma pesquisa de clima 1–2x/ano.
2. **On-device / privado por arquitetura:** só sinais derivados trafegam; nenhuma imagem sai do computador.
3. **Compliance como PILAR, não rodapé:** consentimento como base legal (dado sensível, LGPD art. 11), titularidade do colaborador, agregação com k-anonimato, finalidade limitada a bem-estar (proibido desempenho/disciplina), governança de DPO/RIPD. É isto que torna o produto **superior e vendável**.

---

## 3. ESTRUTURA SLIDE A SLIDE

**Arco:** Problema invisível e caro → Por que o RH está cego → A virada (sinal > pesquisa) → Solução leve e opt-in → Install one-click → Tecnologia on-device → Da leitura bruta ao insight → O colaborador vê primeiro → Dashboard de RH → Insights/triggers → Compliance como pilar → ROI → Visão/posicionamento → CTA.

- **SLIDE 1 — Capa tensionada.** Título: *"O burnout não avisa. Até avisar caro demais."* Tela quase preta; uma única linha de "energia da equipe" descendo por semanas até um X de ruptura. Logo **Interhuman Wellbeing**. Subtítulo: *"Prevenção de burnout com sinais em tempo real — no dispositivo, com consentimento, a favor de quem trabalha."* Só mood, sem gráfico rico.

- **SLIDE 2 — O custo invisível.** Título: *"O Brasil é um dos países mais ansiosos do mundo. Sua folha paga a conta."* 4 cartões de número grande como **placeholders explícitos a citar com fonte** (afastamentos por transtornos mentais CID-F / INSS; custo de turnover por colaborador; % com sintomas de burnout; tempo médio entre desengajamento e pedido de demissão). Rodapé: *"Fontes citadas no apêndice."* Marque visualmente que são dados de mercado, não do produto. **NÃO invente números.**

- **SLIDE 3 — Por que o RH está cego.** Título: *"Você mede engajamento uma vez por ano. O burnout se instala em semanas."* Linha do tempo comparativa: em cima, pontos esparsos "Pesquisa de clima" (1–2x/ano); embaixo, a curva de energia real oscilando toda semana, invisível. O gap entre as duas é a área destacada do problema.

- **SLIDE 4 — A virada de chave.** Título: *"E se o sinal viesse do próprio trabalho — não de um formulário?"* Contraste conceitual: "Autorrelato" (lento, enviesado, raro) vs. "Sinal social em tempo real" (contínuo, passivo, precoce). Ainda conceitual, sem mostrar o produto.

- **SLIDE 5 — A solução em uma frase.** Título: *"Um sensor de bem-estar gentil, no computador de quem quer participar."* Frase-mecanismo: *"A cada hora, por poucos segundos e só com permissão, o agente lê sinais sociais — energia, engajamento, estresse —, processa tudo localmente e devolve ao colaborador o mapa do próprio dia."* Três selos no rodapé: **Opt-in · On-device · O dado é seu.**

- **SLIDE 6 — Instalação ONE-CLICK.** Título: *"Do download ao pronto: 4 telas, 40 segundos, zero fricção."* Storyboard horizontal de 4 mockups: (1) Baixar — instalador leve; (2) Um clique "Ativar bem-estar"; (3) **Consentimento explícito e granular** (câmera sim/não, microfone sim/não, "pause quando quiser", "seu RH nunca vê seu vídeo") com botão grande **"Eu escolho participar"**; (4) Pronto — primeiro insight pessoal aparecendo. Destaque de UX: o consentimento é a 3ª tela, não um EULA escondido — **fricção intencional só no consentimento, zero no resto.**

- **SLIDE 7 — A tecnologia.** Título: *"Multimodal em tempo real. Roda no dispositivo. O vídeo nunca sai."* Diagrama de pipeline honesto: `Webcam + voz (poucos segundos)` → `[BORDA / ON-DEVICE: micro-expressão + prosódia + linguagem]` → **só saem sinais derivados** → `agregação`. Caixa vermelha tracejada **"NUNCA sai do dispositivo"**: frames de vídeo, áudio bruto, transcrição literal. Rotule no slide o **SINAL-BRUTO** (os 12 sinais + Engagement State + CQI 5 dimensões) e a micro-nota: inferência em janelas ~3s, probabilística, não determinística.

- **SLIDE 8 — Da leitura bruta ao insight (a ponte).** Título: *"12 sinais viram 5 leituras que o RH entende."* Mapa de tradução em duas colunas:
  - **SINAL-BRUTO (API):** stress + frustration + hesitation ↑, energy (CQI) ↓, disengagement ↑…
  - **INFERÊNCIA-DERIVADA (nossa camada, longitudinal + agregada):** Índice de Energia ← energy + engagement state; Índice de Carga/Estresse ← stress + frustration + hesitation; Índice de Conexão ← rapport + agreement + interest; Índice de Clareza/Foco ← clarity + confidence + confusion(invertido); Tendência de Desengajamento ← disengagement + queda sustentada de engagement.
  - Selo no slide: *"Leitura de tendência de sinais sociais agregados — não é diagnóstico clínico de saúde mental."*

- **SLIDE 9 — O colaborador vê PRIMEIRO.** Título: *"Antes do RH ver qualquer coisa, você vê o seu."* Mockup do app pessoal: "Seu dia em sinais" — curva de energia por hora, "sua melhor janela de foco foi 9h–11h", "sua energia caiu após o bloco de reuniões". Controles: **pausar hoje / desativar / exportar meus dados / apagar.** Mensagem: *o RH só recebe agregados; alertas individuais só existem se você autorizar.*

- **SLIDE 10 — O DASHBOARD DE RH (coração do produto).** Título: *"O RH enxerga o time — nunca a pessoa (sem consentimento)."* Screenshot-herói do dashboard (detalhado na Parte 4): heatmap de saúde por time × semana + um insight em linguagem natural em destaque + radar de risco. Rótulo grande: **"Visão agregada por time. Mínimo de N pessoas por célula para exibir (k-anonimato)."**

- **SLIDE 11 — Insights automáticos que geram ação.** Título: *"Não é um gráfico a mais. É uma recomendação por semana."* 3 cartões de insight em linguagem natural + ação sugerida:
  - *"O time de Suporte teve queda de 18% no Índice de Energia nas terças, sempre após a reunião de status das 9h. Sugestão: testar formato assíncrono por 3 semanas."*
  - *"A janela de maior foco da Engenharia é 9h–11h; 60% das reuniões caem nesse bloco. Sugestão: proteger a manhã."*
  - *"Índice de Carga de Vendas subiu 3 semanas seguidas no fechamento do mês. Sugestão: reforço temporário / redistribuição."*
  - Cada cartão marcado como **inferência-derivada** com o sinal-bruto de origem em tooltip.

- **SLIDE 12 — Compliance como PILAR (slide de vantagem competitiva).** Título: *"Projetado para a LGPD antes da primeira linha de código."* Grade de 6 pilares:
  1. **Base legal = consentimento** (LGPD art. 11 — dado biométrico + de saúde é **sensível**; regime reforçado; **não** existe legítimo interesse para sensível). Consentimento livre, específico, destacado, revogável, **nunca condição de emprego**.
  2. **On-device / minimização:** só sinais derivados trafegam; vídeo/áudio bruto nunca sai.
  3. **Titularidade do colaborador:** acesso, portabilidade e eliminação self-service; ele vê primeiro.
  4. **Finalidade limitada e vinculada:** bem-estar. **Cláusula contratual + impedimento técnico** proibindo uso em desempenho, disciplina ou desligamento.
  5. **Agregação + k-anonimato:** RH só vê célula com N mínimo; individual só com opt-in adicional.
  6. **Governança:** DPO/Encarregado publicado (canal no app), **RIPD/DPIA**, trilha de auditoria imutável, comitê de ética com representação dos colaboradores, **kill-switch a 1 clique** (art. 8º §5º / art. 18), consentimento renovável.
  - **Enquadramento regulatório:** o produto **NÃO é dispositivo médico e NÃO faz diagnóstico** — posicione como ferramenta de **bem-estar / SST**. Ancore em **NR-1 (gestão de riscos psicossociais) + LGPD** como o par regulatório real; use os disclaimers ANVISA de "não-diagnóstico" como blindagem, mas **não** posicione o produto como SaMD. Mostre no slide os 4 disclaimers: *"Não é diagnóstico de saúde mental / Não substitui avaliação clínica / Sinais são inferências probabilísticas de apoio / Nenhum resultado deve embasar decisão sobre emprego."*
  - Mensagem de fechamento do slide: **"Compliance não é o custo do produto — é o produto."**

- **SLIDE 13 — Casos de uso & ROI.** Título: *"De centro de custo a prevenção que se paga."* 3 cadeias lógicas de ROI com **taxas como variáveis a preencher com o cliente (não invente números):** Retenção (detectar desengajamento semanas antes → intervenção → −X% turnover evitável × custo de reposição); Produtividade (proteger janelas de foco → menos reuniões no pico → horas recuperadas); Absenteísmo/saúde (carga sustentada → ação preventiva → menos afastamentos CID-F). Fórmula-âncora exibida: `ROI = (turnover evitado + horas recuperadas + afastamentos reduzidos) − custo da plataforma`.

- **SLIDE 14 — Visão / posicionamento.** Título: *"A primeira plataforma de bem-estar que ouve o sinal certo, do lado certo da ética."* Mapa 2×2: eixo X "Reativo → Preventivo", eixo Y "Vigilância → Empoderamento do colaborador". Pesquisas de clima no reativo; softwares de monitoramento de produtividade no canto vigilância; **Interhuman Wellbeing sozinho no quadrante Preventivo + Empoderamento.**

- **SLIDE 15 — Fechamento + CTA.** Título: *"Comece com um time. Com consentimento. Em uma semana."* Oferta de piloto: 1 time voluntário, 4–6 semanas, relatório de impacto agregado + garantia de exclusão total dos dados ao fim. Última linha, forte: *"O burnout não avisa. Nós avisamos — a tempo, e com respeito."* Contato / QR do piloto.

- **SLIDE 16 (apêndice, opcional) — Fontes & metodologia.** Todas as estatísticas do slide 2 com referência + a tabela completa sinal-bruto → inferência-derivada para o comprador técnico/jurídico + checklist de prontidão jurídica (RIPD assinado, termo de consentimento art. 11, DPO publicado, cláusulas de finalidade, disclaimers embarcados, comitê de ética, arquitetura auditada, kill-switch testado, política de retenção, alinhamento PGR/NR-1).

---

## 4. ESPECIFICAÇÃO DO DASHBOARD DE RH (para você mockar como screenshots-herói)

**Princípio-mãe de UX:** *toda tela default é agregada e anônima.* O individual é a exceção, sempre atrás de barreira de consentimento visível. O layout inteiro comunica "cuidado", não "controle".

**Shell global:** sidebar esquerda de navegação + topo com seletor de período (semana/mês/trimestre) e de escopo (Organização › Diretoria › Time). **Nunca há seletor "pessoa" no nível raiz.** Barra de conformidade fixa no rodapé de toda tela: *"Exibindo apenas células com ≥ N colaboradores · dados agregados · finalidade: bem-estar"* + link "Como isso protege as pessoas". Células com menos de N pessoas aparecem **hachuradas com cadeado**: *"grupo pequeno demais para exibir com segurança".*

- **TELA 1 — Visão Geral (Home).** 4 KPIs agregados em cards grandes (Índice de Energia, Índice de Carga/Estresse, Índice de Conexão, Tendência de Desengajamento) com valor + seta de tendência + sparkline, rotulados "índice derivado de sinais sociais agregados". Componente central: **HEATMAP Time × Semana** — linhas=times, colunas=semanas, cor=Índice de Energia (métrica selecionável). Escala divergente âmbar (baixa energia) → neutro → teal saudável; **evite vermelho-alarme**. Célula clicável → drill; células pequenas = cadeado. Faixa lateral direita "Insights da semana" (3–5 cartões).
- **TELA 2 — Time em Profundidade (agregado, sem indivíduo).** Cabeçalho com cobertura ("72% do time participa"). **Curva circadiana agregada** (X=hora do dia via hour_local, Y=Índice de Energia; overlay opcional de Carga; marcadores de reuniões recorrentes). **Timeline de engagement state** (área empilhada engaged/neutral/disengaged — sinal-bruto Camada 2, rotular). **Radar CQI** (pentágono clarity/authority/energy/rapport/learning — time vs. org — sinal-bruto Camada 3). **Ranking de janelas ótimas** com ação "proteger janela".
- **TELA 3 — Radar de Risco de Burnout (preventivo).** Matriz scatter/quadrantes: X=Carga/Estresse agregado, Y=queda sustentada de Energia; cada bolha=um time (tamanho=nº pessoas, cor=quadrante). Superior-direito = **"sinais de tendência a monitorar"** (NUNCA "burnout confirmado"). Painel lateral de decomposição: quais sinais-brutos puxam o índice (stress↑, disengagement↑, energy↓) com racionais agregados. Selo: *"Indicador preventivo agregado. Não é diagnóstico individual nem clínico."*
- **TELA 4 — Insights Automáticos (linguagem natural).** Cada cartão: frase-observação + evidência expansível (mini-gráfico + "baseado em: energy↓, disengagement↑ — sinal-bruto; agregação de 3 semanas — inferência") + ação recomendada (botão) + selo de confiança alto/médio/baixo (por raw_signal_count). **Tabela de triggers** (thresholds calibráveis): queda de energia ≥15% por ≥2 semanas → conversa de gestor; Carga acima do P80 por ≥2 semanas → revisão de prazos; desengajamento ↑ em ≥3 semanas → ritual de reconexão; padrão circadiano ruim pós-evento fixo → mover evento; participação <50% → recomunicar valor (não pressionar). **Segurança do alerta:** todo alerta é por time; nenhum nomeia pessoa por padrão; individual só para o próprio colaborador (ou para o RH se e somente se ele ativou compartilhamento). Anti-fadiga de alerta.
- **TELA 5 — Drill-down Individual (exceção, consentimento duplo).** Sem consentimento: *"Este colaborador optou por manter os dados privados. Você pode convidá-lo a compartilhar."* — nada mais. Com consentimento: a mesma visão pessoal que o colaborador vê, banner permanente *"Finalidade: bem-estar. Proibido uso em avaliação, disciplina ou desligamento (cláusula contratual)."* + trilha de auditoria visível: *"Este acesso fica registrado e é visível ao colaborador."*
- **TELA 6 — Governança & Confiança (DPO/jurídico/comprador).** Status de consentimentos (opt-in/opt-out/revogações), configuração do N mínimo (k-anonimato), log de auditoria, exportação/eliminação em massa, RIPD/DPIA anexado, política de retenção. Transmite: "este produto se prova auditável".

---

## 5. DIREÇÃO DE ARTE (mande impressionar)

**Mood:** *enterprise premium + clínico-calmo.* Não é "call center vigiado"; é instrumento de cuidado com gravitas de produto financeiro. Referências de tom: **Linear** (rigor), **Whoop/Oura** (bem-estar longitudinal, curvas suaves), **Stripe** (confiança enterprise), **Notion** (leveza).

**Paleta:**
- Base: grafite muito escuro azulado (near-black, ex. `#0E1116`) no dashboard e na abertura do deck — premium, faz os dados brilharem. Alternativa "clean day" para telas do colaborador: off-white quente (`#FAFAF7`), humanidade e leveza.
- Acento primário: **teal/verde-água sofisticado** (`#3FB6A8`) — saúde, calma; não o verde SaaS genérico.
- Acento secundário: **índigo/violeta suave** (`#7C6CF0`) para inferência/insight — diferencia visualmente "camada de IA" de "sinal-bruto".
- Escala divergente de estado: âmbar quente (`#E8A13A`) → neutro cinza-azulado → teal saudável. **Vermelho reservado e dessaturado** (`#D96C6C`), com parcimônia, nunca default — "cuidado, não alarme".
- **Regra de cor honesta:** sinal-bruto em tons neutros/teal; inferência-derivada sempre marcada com o índigo. O olho aprende a distinguir "medido" de "interpretado".

**Tipografia:** sans geométrica-humanista (Inter, General Sans ou Söhne). Números grandes em semibold com **tabular-figures** (KPIs alinhados). Racionais/insights em regular, leading generoso.

**Dataviz:** curvas suaves (spline), nunca serrilhadas — reforça "tendência", combate leitura de "flagrante". Muito espaço negativo; um foco por vista. Heatmap com cantos arredondados e gaps (respiro), não grade de planilha. Micro-interações lentas (fade/ease ~250ms), nada piscando. Todo gráfico carrega um **selo de origem** discreto: ícone "sinal" (teal) vs. ícone "IA/derivado" (índigo).

**Iconografia:** linha fina, cantos arredondados; motivo recorrente de **onda/pulso suave** (o "sinal") como elemento de marca. **PROIBIDO olho, câmera, lupa** (semiótica de vigilância) — use coração-pulso, folha, onda.

**Deck:** capa escura cinematográfica; slides de dado com fundo escuro e um dado-herói cada; **slides de compliance podem inverter para fundo claro** (transmite "transparência, luz"). Transições sóbrias. Uma ideia por slide, número gigante quando houver número.

**Mensagem que a estética inteira carrega:** *"Isto respeita quem trabalha. É medido com cuidado, interpretado com humildade, e existe para proteger — não para vigiar."*

---

## 6. REQUISITOS DE ENTREGA

- **Formato:** deck de apresentação de alto padrão, **16:9**, 15 slides + 1 apêndice. Densidade baixa (uma ideia por slide), tipografia grande, dado-herói por slide.
- **Heróis primeiro:** produza com prioridade os **Slides 1, 6, 10 e a Tela 1 do dashboard** — são os que validam a direção visual. Depois escale para o deck completo.
- **DO:** enquadramento anti-vigilância em cada slide; selos Opt-in/On-device/O-dado-é-seu recorrentes; separação visual sinal-bruto (teal) vs. inferência (índigo); linguagem de "tendência agregada", não "diagnóstico".
- **DON'T:** **não invente números** — todo dado de mercado (slide 2) e taxa de ROI (slide 13) entra como **placeholder rotulado "fonte a preencher"**; nunca use ícones de câmera/olho/lupa; nunca rotule risco como "burnout confirmado"; nunca posicione como dispositivo médico/SaMD; nunca mostre dado individual sem a barreira de consentimento.
- **Exigência ética (obrigatória):** todo output do RH é **agregado, anonimizado, com k-anonimato (N ≥ 5 sugerido)**; finalidade limitada a bem-estar; kill-switch e titularidade do colaborador sempre visíveis.

---

## 7. FRASE-GUIA FINAL

**Faça de forma que um diretor de RH de multinacional aprove na primeira olhada — e que o jurídico/DPO dele assine embaixo na segunda.** Cada slide deve provar, ao mesmo tempo, que o produto é *desejável* (resolve uma dor cara e invisível), *possível* (tecnologia real, on-device) e *defensável* (compliance é a arquitetura, não o disclaimer). Vigilância concentra dados no empregador; **nós devolvemos o controle ao colaborador e entregamos ao RH apenas o coletivo — com governança auditável em cada afirmação.**