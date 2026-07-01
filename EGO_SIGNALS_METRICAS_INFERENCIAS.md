# Ego Signals — Referência de Métricas, Análises e Inferências

Documento de fonte de verdade para a ferramenta **Ego Signals**, construída sobre a **Interhuman Signals API**. A ferramenta capta, em tempo real e a partir da webcam do colaborador (vídeo + voz), uma inferência **multimodal** que funde três canais — micro-expressão facial, prosódia/voz e linguagem — em chunks de ~3s enviados via WebSocket (`session.ready` · `signal.detected/updated/ended` · `engagement.updated` · `conversation_quality.updated`). Ela **não mede emoção verdadeira**: infere a *probabilidade de expressão observável* de sinais sociais. Toda a inferência roda **on-device** (só o vetor de sinais derivados trafega; vídeo/áudio bruto nunca sai do PC), sob **opt-in informado**, com o dado pertencendo ao colaborador — que o vê **antes** do RH, que por sua vez só enxerga **agregados anonimizados por time** (k-anonimato). Finalidade travada por design: **bem-estar e prevenção de burnout**, jamais desempenho, ranking ou disciplina.

> **Convenção de marcação.**
> **[SINAL BRUTO]** = valor entregue diretamente pela API (inferência multimodal do modelo).
> **[INFERÊNCIA DERIVADA]** = leitura, índice ou interpretação construída *por cima* dos sinais brutos — hipótese analítica, não medição direta.

---

## 0. Fundamentos e limites epistemológicos

Três limites atravessam **todo** o documento:

1. **Sinal ≠ estado mental.** "Alta probabilidade de stress" = "o padrão multimodal se parece com o que o modelo aprendeu como stress", não "a pessoa está sofrendo".
2. **Probabilidade categórica, não escalar contínua.** Cada sinal chega como `low / medium / high` (3 níveis) + racional textual + timestamps — não como float 0–1. A granularidade fina vem de **duração**, **frequência** e **co-ocorrência**.
3. **Contexto é externo ao dado.** O modelo não sabe se a pessoa está numa reunião difícil, com dor de cabeça ou concentrada. A interpretação exige contexto que a API não fornece.

**Guardrails não-negociáveis (permeiam cada métrica):**

| Princípio | Implicação |
|---|---|
| Opt-in + consentimento revogável | Nenhuma métrica existe sem consentimento ativo. |
| Processamento on-device | Só sinais derivados trafegam; vídeo bruto nunca sai do PC. |
| Dado é do colaborador | O indivíduo vê o próprio painel **antes** do RH. |
| RH vê agregado/anonimizado por time | Alerta individual só com consentimento explícito adicional. |
| Finalidade limitada a bem-estar | **Proibido** para desempenho, disciplina, ranking ou desligamento. |
| Transparência + DPO | Toda métrica precisa de definição pública e governança. |

> **Regra de ouro:** qualquer índice deste documento que possa ser reaproveitado como métrica de produtividade individual **deve ser bloqueado por design** (agregação mínima, k-anonimato ≥5, ausência de ranqueamento individual). Índice que não passa nesse teste não vai para produção.

---

## Camada 1 — Os 12 Sinais Sociais

**Formato de cada sinal na API** [SINAL BRUTO]: `signal` (nome) · `probability` (`low`|`medium`|`high`) · `rationale` (texto do *porquê*) · `start`/`end`/`duration` · ciclo de eventos `signal.detected → signal.updated → signal.ended`.

| # | Sinal | O que capta [SINAL BRUTO] | Racional típico (API) | Leitura-chave [INFERÊNCIA DERIVADA] |
|---|---|---|---|---|
| 1 | **Engagement** | Presença atenta e investida — orientação facial, vivacidade prosódica, responsividade. | "sustained eye contact, active vocal variation" | *High* prolongado que cai no fim → **fadiga de atenção**; janelas curtas e fragmentadas → **atenção intermitente** por multitarefa. |
| 2 | **Interest** | Atração ativa por um tópico — inclinação, sobrancelhas elevadas, perguntas exploratórias. | "leaning in, rising intonation on question" | Alto em aprendizado → **motivação intrínseca**; cronicamente baixo em quem era engajado → **desmotivação/desconexão** (gatilho de conversa, nunca punição). |
| 3 | **Agreement** | Alinhamento ativo — acenos, "sim/exato", prosódia de validação. | "repeated head nods, affirmative backchannel" | Genuíno e distribuído → **coesão**; rápido/uniforme sem interest → **conformidade social** (baixa segurança psicológica). |
| 4 | **Confidence** | Firmeza — voz estável, ritmo sem hesitação, afirmações sem hedging. | "steady pace, declarative phrasing, minimal fillers" | Estável ao explicar o próprio trabalho → **maestria** (protetor de burnout); despenca em tópicos específicos → **lacuna de competência**. |
| 5 | **Confusion** | Dificuldade de processar — testa franzida, micro-pausas, pedidos de repetição. | "furrowed brow, clarification request" | Pontual em tema novo → **carga cognitiva normal**; recorrente e coletiva → **problema de comunicação/processo**, não deficiência individual. |
| 6 | **Hesitation** | Relutância momentânea — pausas de preenchimento, falsos inícios, atraso de resposta. | "filled pauses, delayed onset" | Antes de discordar → **medo de expor opinião** (inverso de segurança psicológica); + confidence baixa → **sobrecarga decisória**. |
| 7 | **Uncertainty** | Baixa convicção sobre o conteúdo — hedging ("acho que"), uptalk em afirmações. | "hedged language, uptalk on statements" | Distinta de confusion: **entende mas não tem certeza** → falta de dados; crônica → **falta de clareza de escopo/autonomia**. |
| 8 | **Skepticism** | Dúvida crítica sobre a validade — sobrancelha única, tom questionador, contra-perguntas. | "unilateral brow raise, probing counter-question" | Em debate técnico → **pensamento crítico** (positivo); + disagreement + rapport baixo → **erosão de confiança na liderança**. |
| 9 | **Disagreement** | Oposição ativa — negação verbal, balanço de cabeça, objeções. | "head shake, contrastive stress, explicit objection" | Expresso abertamente → **segurança psicológica presente**; suprimido (hesitation alta + skepticism alto) → **conflito latente**. |
| 10 | **Frustration** | Irritação/bloqueio — tensão facial, suspiros, intensidade vocal, impaciência. | "audible sigh, clipped speech, jaw tension" | Picos ligados a ferramentas → **atrito operacional** (fricção de sistema); difusa e recorrente → **marcador precoce de esgotamento**. |
| 11 | **Stress** | Ativação de tensão — micro-tensão facial, pitch elevado, ritmo travado, respiração audível. | "elevated pitch, rushed tempo, facial tension" | Agudo/pontual → **resposta normal**; **persistente hora após hora, dias/semanas → marcador central de risco de burnout** (a tendência importa muito mais que a leitura isolada). |
| 12 | **Disengagement** | Retirada — olhar disperso, prosódia plana, respostas mínimas, alta latência, sem backchannel. | "flat affect, minimal responses, gaze aversion" | Crescente no tempo → **exaustão emocional**; alto + stress baixo → **apatia checked-out**; alto + stress alto → **colapso de recursos sob sobrecarga**. |

**Matriz de valência e prioridade** [INFERÊNCIA DERIVADA]:

| Valência | Sinais | Marcador prioritário de bem-estar |
|---|---|---|
| Positiva | Engagement, Interest, Confidence | Presença, motivação intrínseca, maestria (protetores) |
| Contextual | Agreement, Confusion, Hesitation, Uncertainty, Skepticism, Disagreement | Coesão, carga cognitiva, insegurança, clareza, crítica, segurança psicológica |
| **Negativa** | **Frustration, Stress, Disengagement** | **Pré-burnout, risco de burnout (tendência), exaustão/distanciamento** |

---

## Camada 2 — Engagement State (estado contínuo)

Classificação contínua em três categorias via `engagement.updated`, com **% do tempo** em cada estado + **timeline** (curva ao longo da sessão).

| Métrica [SINAL BRUTO] | Leitura |
|---|---|
| **% engaged** | Fração da sessão em presença investida. |
| **% neutral** | Fração em atenção morna/transição. |
| **% disengaged** | Fração em retirada/desconexão. |
| **Timeline (curva)** | Trajetória do estado ao longo do tempo. |

**A forma da curva importa mais que a média** [INFERÊNCIA DERIVADA]:

| Forma da curva | Leitura | Ação de bem-estar |
|---|---|---|
| **Declínio monotônico** (engaged→disengaged) | Fadiga de atenção; blocos longos demais. | Encurtar blocos, inserir pausas. |
| **Serrilhado / oscilante** | Atenção intermitente por interrupções/multitarefa (custo cognitivo alto). | Proteger blocos de foco. |
| **Vale no meio com recuperação** | Queda situacional a um trecho; resiliência preservada. | Monitorar o gatilho pontual. |
| **Piso baixo desde o início** | Entrada já desengajada — recuperação insuficiente / sono / sobrecarga acumulada. | Sinal de energia baixa crônica. |
| **Platô engajado caindo entre dias** (comparando sessões) | **A métrica mais valiosa**: teto de engajamento erodindo semana a semana. | Candidato #1 a intervenção preventiva de burnout. |

> Para o RH, a timeline é sempre **agregada por time** (curva média + banda), nunca individual identificada sem consentimento.

---

## Camada 3 — Conversation Quality Index (CQI) + 5 Dimensões

**CQI** [SINAL BRUTO]: índice **0–100** via `conversation_quality.updated`, com **snapshot** (valor corrente) + **timeline** (evolução). Síntese das 5 dimensões abaixo (cada uma 0–100) [SINAL BRUTO].

| Dimensão | Definição | ALTA indica | BAIXA indica |
|---|---|---|---|
| **Clarity** | Organização/inteligibilidade da comunicação. | Ideias estruturadas, baixa confusion no interlocutor. | Mensagem truncada; comunicação exige retrabalho. |
| **Authority** | Firmeza e domínio percebidos de quem conduz. | Confiança sustentada, comando do tema. | Insegurança, hedging, hesitation alta. |
| **Energy** | Vitalidade e dinamismo. | Prosódia viva, ritmo saudável. | Monotonia, apatia, disengagement → **fadiga** (leitura direta de bem-estar). |
| **Rapport** | Sintonia e segurança relacional. | Reciprocidade, conforto para discordar. | Frieza, tensão, baixa segurança psicológica. |
| **Learning** | Disposição para explorar, perguntar, absorver. | Interest alto, mente aberta. | Fechamento, rigidez → possível esgotamento cognitivo. |

**Leitura do CQI 0–100** [INFERÊNCIA DERIVADA] (calibrar por baseline do time, não como corte absoluto):

| Faixa | Leitura |
|---|---|
| **80–100** | Interação de alta qualidade; presença, clareza e conexão fortes. |
| **60–79** | Saudável, com uma ou duas dimensões a reforçar. |
| **40–59** | Sinais de atrito; olhar *qual* dimensão puxa para baixo. |
| **0–39** | Interação degradada; se recorrente com energy/rapport baixos → bandeira de bem-estar coletivo. |

**O *shape* das dimensões conta a história que o CQI agregado esconde** [INFERÊNCIA DERIVADA]:

- **Energy sozinha em queda, resto estável** → fadiga física/mental sem perda de competência — marcador precoce clássico de esgotamento.
- **Rapport baixo + Authority alta** → comunicação dominante e pouco conectada; a mensagem "chega" mas não gera segurança.
- **Learning + Energy caindo juntas por semanas** → desengajamento profundo, a assinatura mais preocupante para burnout.
- **Clarity baixa recorrente e coletiva** → problema de **processo de comunicação organizacional**, não das pessoas.

---

## Camada 4 — Métricas Derivadas por Sessão

A **API já as calcula e entrega** por sessão [SINAL BRUTO]; a *interpretação* é [INFERÊNCIA DERIVADA].

| Métrica (API) | O que é | O que permite inferir |
|---|---|---|
| **top_signals** (+ **avg_intensity 1–3**) | Sinais mais presentes + intensidade média (1=low, 3=high). | Assinatura emocional dominante. Ex.: stress+frustration ~3 → sessão de alta tensão. |
| **avg_audio_activity (0–1)** | Proporção do quanto a pessoa falou. | Participação verbal. Baixo em quem devia conduzir → retração; muito alto e sozinho → sobrecarga de fala one-way. |
| **questions_answered** | Nº de perguntas respondidas. | Volume de interação; base para normalizar reatividade. |
| **most_silent_question** | Pergunta com menor atividade de áudio. | Tópico onde a pessoa **se calou** — evitação, desconforto ou desconhecimento. |
| **most_talkative_question** | Pergunta com maior atividade de áudio. | Tópico de **maior domínio/energia** — onde se sente à vontade. |
| **most_reactive_question** | Pergunta que disparou mais sinais. | **Gatilho emocional** — o tema que mais mexeu (stress *ou* interesse; ler pelos sinais associados). |
| **hour_local** + **time_of_day** | Hora local e período. | **Cronobiologia do bem-estar** — mapear se a tensão se concentra em fim de tarde, segundas etc. |
| **raw_signal_count** | Contagem bruta de sinais na sessão. | Densidade de ativação; base de normalização para índices. |
| **per_question[]** | Detalhe por pergunta (abaixo). | Micro-análise pergunta a pergunta. |
| └ *audio_activity* | Fala naquela pergunta. | Engajamento verbal localizado. |
| └ *really_answered* | Se a pergunta foi de fato respondida. | Distingue "falou" de "respondeu" — evita superestimar participação. |
| └ *signals[]* | Sinais disparados na pergunta. | Perfil emocional por tópico. |
| └ *engagement_changes[]* | Mudanças de estado dentro da pergunta. | Momento exato em que se "perdeu/ganhou" a pessoa. |

> **Uso responsável:** `most_talkative_question`, `avg_audio_activity` etc. **não** medem produtividade. Falar menos não é performar menos. Uma queda de `avg_audio_activity` ao longo do tempo interessa como **sinal de retração/desengajamento**, não como métrica de output.

---

## Camada 5 — Índices Compostos [INFERÊNCIA DERIVADA]

> **Metodologia.** Codificação padrão **low=1, medium=2, high=3**; **0** quando inativo. Pondere por **duração** e **frequência** (um *high* por 2s pesa menos que *medium* por 40s). Pesos (α, β, …) **calibrados por baseline do time**, não fixos. Fórmulas são **conceituais**, não prontas para produção sem validação. `S(x)` = intensidade agregada do sinal x (nível × duração × frequência, normalizado 0–1). Todos reportados **0–100** e **sempre agregados por time**.

| Índice | Fórmula conceitual | Mede | Direção saudável | Leitura-chave |
|---|---|---|---|---|
| **ICC** Carga Cognitiva | `norm(α·S(confusion)+β·S(hesitation)+γ·S(uncertainty))` | Esforço mental de processar/decidir. | Baixo/moderado | Picos = aprendizado; crônico = tarefa mal dimensionada / falta de info. |
| **ITN** Tensão | `norm(α·S(stress)+β·S(frustration))` | Carga afetiva negativa aguda. | Baixo (tendência) | **Preditor mais direto de burnout**; o *slope* vale mais que o nível. |
| **ISP** Segurança Psicológica | `norm(α·Rapport+β·S(confidence)+δ·S(disagreement_expresso)−γ·S(disengagement)−ε·S(hesitation_pré-fala))` | Segurança para se expor, discordar, errar. | Alto | Baixo + skepticism/hesitation altos = silêncio conformista, conflito latente. |
| **IVE** Vitalidade | `norm(α·Energy+β·%engaged+γ·S(engagement)+δ·S(interest)−ε·S(disengagement))` | Reserva de energia e presença ativa. | Alto | **Termômetro central de bem-estar**; queda sustentada = exaustão pré-burnout. |
| **IRD** Resistência/Desconfiança | `norm(α·S(skepticism)+β·S(disagreement)+γ·S(frustration)−δ·Rapport)` | Atrito relacional / resistência à liderança. | Baixo/moderado | Moderado em debate = crítica saudável; alto e difuso = erosão de confiança. |
| **ICL** Clareza Comunicacional | `norm(α·Clarity+β·S(agreement)+γ·S(really_answered)−δ·S(confusion)−ε·S(uncertainty))` | Fluxo de informação (emissor + receptor). | Alto | Baixo coletivo/recorrente = falha de **processo de comunicação**, não do indivíduo. |
| **IRC** Retração | `norm(α·%disengaged+β·S(disengagement)+γ·(1−avg_audio_activity)−δ·S(interest))` | Grau de afastamento/silêncio. | Baixo | Crescente em quem era participativo = alerta precoce; combinar com ITN (ver abaixo). |
| **IBE** Bem-Estar Composto *(mestre)* | `norm(w1·IVE+w2·ISP+w3·ICL−w4·ITN−w5·ICC−w6·IRC)` | Síntese única de bem-estar. | Alto | **KPI de topo, por time. A tendência (slope) é o produto**, não o valor absoluto. |

**Combinações diagnósticas** [INFERÊNCIA DERIVADA]:
- **IRC alto + ITN baixo** = apatia / checked-out (desligamento passivo).
- **IRC alto + ITN alto** = colapso de recursos sob sobrecarga (esgotamento ativo).

> **Trava obrigatória do IBE:** não pode ser calculado/exibido para indivíduo identificado sem consentimento adicional, não alimenta avaliação de desempenho, e exige **k-anonimato ≥5** antes de qualquer exibição ao RH.

---

## Camada 6 — Inferências Humanamente Imperceptíveis (o fator "uau")

O poder da ferramenta **não** está em nenhum sinal isolado — a API já os entrega com competência. Está na **quarta dimensão: o tempo**, mais a **agregação entre pessoas** e a **fusão multimodal**. Um humano vê fotografias; a ferramenta vê o *filme em câmera lenta de meses*, com três trilhas de áudio sobrepostas, e detecta a inclinação de rampas lentas demais para a consciência registrar. Todas as inferências abaixo são [INFERÊNCIA DERIVADA] e só são legítimas **dentro** da moldura ética (dado individual primeiro ao colaborador; RH só no agregado).

### 6.A — O tempo revela o que o instante esconde (medição horária)

| # | Inferência | Combina | Por que é humanamente imperceptível |
|---|---|---|---|
| 1 | **Deriva Circadiana de Energia** (energy fingerprint) | `energy` (CQI horário) + engagement state + `avg_audio_activity` + `hour_local`, empilhados em perfil médio de 24h. | Ninguém amostra a própria energia 8–10x/dia por semanas. A pessoa "sente" que rende de manhã, mas não sabe que seu pico real é 9h40–11h20 e que há um vale sistemático às 14h30. |
| 2 | **Fadiga de Decisão Acumulada** (intraday depletion slope) | Queda de `confidence`+`clarity` da 1ª à última interação + subida de hesitation/uncertainty + queda de audio_activity. | O declínio é de poucos pontos por hora, sub-perceptual em qualquer interação isolada; só a regressão sobre dezenas de pontos revela a rampa. |
| 3 | **Janela de Trabalho Profundo** (deep-work window) | Picos de `clarity` + `%engaged` alto + ausência de frustration/confusion/stress × `hour_local`. | Exige correlacionar três sinais contra o relógio por semanas. "Bloqueie 9h30–11h para deep work" é impossível por introspecção. |
| 4 | **Assinatura de Recuperação** (recovery signature) | Decaimento de stress/frustration (duração dos sinais) + tempo até energy/rapport voltarem ao baseline. | A velocidade de recuperação é uma curva entre eventos separados por horas; seu encurtamento progressivo em meses é marcador precoce de esgotamento crônico. |

### 6.B — A trajetória lenta que antecede a ruptura (semanas/meses)

| # | Inferência | Combina | Por que é humanamente imperceptível |
|---|---|---|---|
| 5 | **Trajetória de Burnout Pré-Colapso** (burnout glide-path) | Tendência semanal de `energy`↓ + frustration/stress nos top_signals↑ + rapport↓ + disengagement↑. | Cada semana muda 1–2%, imperceptível no dia a dia; só a linha de 6–10 semanas revela a inclinação — e ainda dá tempo de intervir. **Autocuidado privado ao colaborador primeiro; RH só no agregado.** |
| 6 | **Sobrecarga Pré-Afastamento** (pre-leave overload) | `stress` em **platô** (não picos) + `energy` em mínimo histórico pessoal + audio_activity despencando + disengagement dominante. | A diferença entre "estresse agudo pontual" (normal) e "platô sustentado" (perigoso) só aparece na distinção pico vs. linha de base deslocada — o humano funde tudo em "ela anda cansada". |
| 7 | **Antecipação de Saída Voluntária** (regretted-attrition signal) | `disengagement`↑ sustentado + interest/engagement↓ + rapport↓ + `learning`↓. | O desengajamento pré-saída é *educadamente mascarado* — a pessoa segue entregando. Rosto/voz vazam a retração muito antes do comportamento. Ninguém detecta "queda de curiosidade de 12% em 8 semanas". |
| 8 | **Descolamento de Baseline** (baseline drift) | Média móvel longa de engagement state + CQI pessoal comparado ao *próprio* histórico. | A adaptação hedônica engana a própria pessoa — você se acostuma ao seu novo pior e o chama de "normal". Só a memória estatística de longo prazo flagra o desvio. |

### 6.C — O que só emerge entre pessoas (agregação de time)

| # | Inferência | Combina | Por que é humanamente imperceptível |
|---|---|---|---|
| 9 | **Contágio Emocional / Propagação de Estresse** (affective contagion map) | Timestamps de stress/frustration entre membros do time + defasagem temporal (quem sobe antes/depois) × `hour_local`. | Contágio opera em janelas de minutos-horas, entre pessoas que talvez nem interajam; só a correlação cruzada temporal revela o vetor — e o "paciente zero" **nunca** é individualizado ao RH. |
| 10 | **Impacto Real de Reuniões/Lideranças** (meeting/leader wake effect) | Delta agregado de energy/rapport/stress do time **antes vs. depois** de uma janela recorrente × `time_of_day`. | O efeito só aparece comparando milhares de pontos pré/pós ao longo de meses. "A daily das segundas custa 7 pontos de energia do time" é invisível no ruído. |
| 11 | **Fratura de Segurança Psicológica Pós-Evento** (psych-safety fracture) | `rapport` agregado↓ + hesitation/uncertainty/skepticism↑ + `avg_audio_activity` do time↓, logo após reestruturação/demissão/anúncio. | A retração de segurança é justamente o que fica *não-dito* — silêncio e microhesitação distribuídos. Só a queda simultânea de rapport + fala no agregado a torna mensurável. |
| 12 | **Divergência de Clima Entre Times** (team climate divergence) | CQI médio e `%engaged` agregados por time, comparados entre si por semanas. | Cada gestor só vê o próprio time e não tem baseline comparável; a divergência estrutural só salta na visão agregada lado a lado, normalizada, ao longo do tempo. |

### 6.D — Fusão multimodal: quando rosto, voz e palavra discordam

| # | Inferência | Combina | Por que é humanamente imperceptível |
|---|---|---|---|
| 13 | **Descompasso Fala-Face** (say-feel gap / incongruência) | Camada de linguagem ("tá tudo tranquilo") vs. hesitation+uncertainty+stress de face/voz no **mesmo timestamp**. | O cérebro humano acredita nas *palavras* e descarta o vazamento não-verbal (ou o sente vago como "achei ela estranha"). A máquina alinha os três canais no milissegundo e nomeia o gap. |
| 14 | **Confiança Genuína vs. Performada** (authentic vs. performed) | `confidence` × presença simultânea de hesitation/uncertainty sub-perceptuais × dimensão `authority`. | A performance de confiança é *desenhada* para enganar o observador humano; o micro-tremor que a contradiz está abaixo do limiar consciente. Útil ao *próprio* colaborador ("você minimiza sua sobrecarga"). |
| 15 | **Dissonância Cognitiva em Tempo Real** (confusion-masking) | `agreement` (verbal "entendi") coexistindo com `confusion` no mesmo instante + `most_reactive_question`/per_question para localizar onde travou. | O "entendi" de cortesia é uma das máscaras sociais mais eficazes. Só a contradição sincrônica verbal↔não-verbal a desmonta — e por pergunta, mostra qual onboarding não pegou. |

### 6.E — Micro-variações e padrões de segunda ordem

| # | Inferência | Combina | Por que é humanamente imperceptível |
|---|---|---|---|
| 16 | **Volatilidade Emocional** (affective variability) | Variância/desvio-padrão do engagement state e do CQI dentro do dia e entre dias (não a média). | Percepção humana capta níveis, não variâncias. A variância frequentemente sobe **antes** da média cair (early warning clássico de sistemas à beira de transição). |
| 17 | **Latência de Reengajamento** (reengagement latency) | Duração dos episódios de `disengagement` + intervalo até o próximo `engaged`, agregado por semanas. | Métrica de *tempo entre eventos* em segundos/minutos; ninguém cronometra "hoje ele levou 40% mais tempo pra reengajar que há um mês". |
| 18 | **Erosão do Apetite por Aprender** (learning-curiosity decay) | Tendência longa da dimensão `learning` + queda de `interest` em contextos novos. | Curiosidade é difusa e episódica; sua erosão de meses se confunde com "amadurecimento" ou "está mais quieto". Só a linha de tendência isola o declínio real. |
| 19 | **Tema que Detona Estresse** (reactive-topic fingerprint) | `most_reactive_question` + `per_question.signals[]` agregados por tema em muitas sessões. | O gatilho aparece diluído em dezenas de contextos; só a agregação por tema revela "toda vez que o assunto é 'prazo do cliente X' o estresse do time sobe 2 níveis". |
| 20 | **Sincronia/Ritmo do Time** (team rhythm coherence) | Correlação cruzada das curvas de engagement state/energy entre membros do time ao longo do dia. | Sincronia é propriedade emergente do *conjunto* de curvas, invisível em qualquer indivíduo. A queda de coerência (uns exaustos, outros ociosos) marca distribuição injusta de carga. |
| 21 | **Custo de Troca de Contexto** (context-switch tax) | Delta de clarity/energy + subida de confusion nas transições entre per_question/sessões de natureza diferente, por perfil. | O custo de cada troca é pequeno e racionalizado ("só me distraí"); somado por perfil em semanas, revela quem precisa de blocos protegidos e quem tolera fragmentação. |

---

## 7. Governança da taxonomia (fecho não-negociável)

1. **Toda métrica individual pertence ao colaborador** e é exibida a ele **antes** de qualquer agregação chegar ao RH.
2. **RH recebe apenas agregados anonimizados por time** (k-anonimato ≥5) + **timelines de tendência** — nunca leituras cruas de indivíduos identificados sem consentimento adicional.
3. **Finalidade travada por design:** nenhum índice pode alimentar avaliação de desempenho, disciplina ou ranqueamento. Índices desviáveis para isso têm exibição individual bloqueada.
4. **A tendência é o produto, não o instante.** O valor está nas curvas ao longo do tempo (slope de IVE, ITN, IBE), que permitem **prevenção** — não em fotografias que expõem pessoas.
5. **Sinal bruto vs. inferência:** todo painel deve marcar visualmente o que é medição direta **[SINAL BRUTO]** e o que é hipótese analítica **[INFERÊNCIA DERIVADA]**, para nunca vender inferência como fato.
6. **Visão sobre-humana + governança que a devolve ao indivíduo:** uma capacidade que enxerga o que a pessoa não vê em si própria só é legítima se servir **primeiro à própria pessoa**. É essa combinação que torna o produto impressionante **e** defensável.