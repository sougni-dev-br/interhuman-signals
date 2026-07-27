-- ============================================================================
-- EGO Pulse — schema inicial (Postgres / Supabase)
-- Plataforma de gestão de riscos psicossociais NR-1.
-- Enquadramento: SINAL, não diagnóstico (fora de SaMD/ANVISA).
--
-- Privacidade por construção:
--   * complaints NÃO tem coluna de identidade/IP (anonimato estrutural).
--   * sinais individuais nunca são expostos por endpoint; gestor/RH só veem
--     agregados com N >= min_n (k-anon), calculados no backend.
--   * RLS ligada em tudo, SEM policy permissiva p/ anon/authenticated →
--     a Data API pública devolve zero. Todo acesso passa pelo backend Node
--     (service_role, que faz bypass de RLS) com autorização no código.
-- ============================================================================

create extension if not exists pgcrypto;  -- gen_random_uuid()

-- ---------------------------------------------------------------------------
-- 1. Organização (tenant)
-- ---------------------------------------------------------------------------
create table if not exists organizations (
  id             uuid primary key default gen_random_uuid(),
  name           text not null,
  slug           text unique not null,
  complaint_slug text unique,                 -- slug do canal público de denúncia
  min_n          int  not null default 5,     -- limiar k-anon p/ agregados
  work_window    jsonb,                        -- janela de trabalho (after-hours via Atera, futuro)
  created_at     timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 2. Usuários da aplicação (auth Node: scrypt + token HMAC). Não usa Supabase Auth.
--    Papéis: admin | gestor_rh | colaborador | guest
-- ---------------------------------------------------------------------------
create table if not exists app_users (
  id            bigint generated always as identity primary key,
  org_id        uuid references organizations(id) on delete set null,
  email         text unique not null,
  password_hash text not null,
  role          text not null default 'colaborador'
                  check (role in ('admin','gestor_rh','colaborador','guest')),
  department    text,
  active        boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz
);
create index if not exists idx_app_users_email on app_users(email);
create index if not exists idx_app_users_org   on app_users(org_id);

-- ---------------------------------------------------------------------------
-- 3. Sessões de observação (câmera+áudio) — base das inferências (#1)
-- ---------------------------------------------------------------------------
create table if not exists sessions (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid references organizations(id) on delete set null,
  user_id            bigint references app_users(id) on delete set null,
  department         text,
  started_at         timestamptz not null default now(),
  ended_at           timestamptz,
  duration_s         int,
  -- métricas agregadas da sessão (desnormalizadas p/ leitura rápida)
  cqi                int,                      -- quality_index 0-100
  cqi_clarity        int,
  cqi_authority      int,
  cqi_energy         int,
  cqi_rapport        int,
  cqi_learning       int,
  engagement_pct     jsonb,                    -- {engaged, neutral, disengaged}
  voice_activity_pct numeric,
  raw_signal_count   int,
  top_signals        jsonb,                    -- [{type, count, avg_intensity}]
  signal_summary     jsonb,                    -- [{type, count, probabilities}]
  source             text default 'observation',
  created_at         timestamptz not null default now()
);
create index if not exists idx_sessions_org_time  on sessions(org_id, started_at);
create index if not exists idx_sessions_user_time on sessions(user_id, started_at);

-- ---------------------------------------------------------------------------
-- 3b. Eventos granulares de sinal — "todos os dados" p/ inferência (#1)
--     (conversation_quality.updated, engagement.updated, signal.detected...)
-- ---------------------------------------------------------------------------
create table if not exists session_signal_events (
  id         bigint generated always as identity primary key,
  session_id uuid references sessions(id) on delete cascade,
  org_id     uuid references organizations(id) on delete set null,
  ts         timestamptz not null default now(),
  kind       text not null,                    -- tipo do evento upstream
  payload    jsonb not null
);
create index if not exists idx_events_session on session_signal_events(session_id);
create index if not exists idx_events_org_time on session_signal_events(org_id, ts);

-- ---------------------------------------------------------------------------
-- 4. Relatórios (#2): perfilamento diário (1x/dia) + sinais horário (Atera)
-- ---------------------------------------------------------------------------
create table if not exists reports (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid references organizations(id) on delete set null,
  user_id      bigint references app_users(id) on delete set null,
  department   text,
  kind         text not null
                 check (kind in ('perfilamento_diario','sinais_horario')),
  period_start timestamptz,
  period_end   timestamptz,
  markdown     text,                            -- relatório diário (perfilamento)
  data         jsonb,                            -- snapshot estruturado (horário só-sinais)
  source       text,                             -- claude-v2 | rule-based | timeout | ...
  model        text,
  session_ids  uuid[],
  created_at   timestamptz not null default now()
);
create index if not exists idx_reports_org_kind_time on reports(org_id, kind, created_at);
create index if not exists idx_reports_user_time      on reports(user_id, created_at);

-- ---------------------------------------------------------------------------
-- 5. Canal de denúncia — 100% ANÔNIMO (#3.2)
--    SEM identidade, SEM IP, SEM user_id. Só o org_id (qual canal).
-- ---------------------------------------------------------------------------
create table if not exists complaints (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid references organizations(id) on delete set null,
  type             text not null,               -- assédio moral/sexual/religioso/racial/bullying/outros
  description      text not null,
  extra_info       text,
  sentiment_label  text,                         -- positivo|neutro|negativo|critico
  sentiment_score  numeric,
  criticality      text,                         -- baixa|media|alta|critica
  status           text not null default 'aberta'
                     check (status in ('aberta','em_analise','resolvida','arquivada')),
  resolution_notes text,
  created_at       timestamptz not null default now()
);
create index if not exists idx_complaints_org_status on complaints(org_id, status);

-- ---------------------------------------------------------------------------
-- 6. Integração Atera — log dos disparos do relatório horário (#2)
-- ---------------------------------------------------------------------------
create table if not exists atera_runs (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid references organizations(id) on delete set null,
  triggered_at      timestamptz not null default now(),
  period_start      timestamptz,
  period_end        timestamptz,
  reports_generated int default 0,
  status            text,
  error             text
);
create index if not exists idx_atera_runs_org_time on atera_runs(org_id, triggered_at);

-- ---------------------------------------------------------------------------
-- 7. Auditoria mínima (ações sensíveis: mudança de papel, status de denúncia)
-- ---------------------------------------------------------------------------
create table if not exists audit_log (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid references organizations(id) on delete set null,
  actor      text,                               -- email do ator (nunca do denunciante)
  action     text not null,
  entity     text,
  entity_id  text,
  meta       jsonb,
  created_at timestamptz not null default now()
);
create index if not exists idx_audit_org_time on audit_log(org_id, created_at);

-- ---------------------------------------------------------------------------
-- 8. RLS — deny-by-default. Backend usa service_role (bypass). Data API pública
--    fica fechada (nenhuma policy permissiva). É a 2a camada de privacidade.
-- ---------------------------------------------------------------------------
alter table organizations        enable row level security;
alter table app_users            enable row level security;
alter table sessions             enable row level security;
alter table session_signal_events enable row level security;
alter table reports              enable row level security;
alter table complaints           enable row level security;
alter table atera_runs           enable row level security;
alter table audit_log            enable row level security;

-- ---------------------------------------------------------------------------
-- 9. Seed — organização default (Sougni). complaint_slug será usado na URL pública.
-- ---------------------------------------------------------------------------
insert into organizations (name, slug, complaint_slug, min_n)
values ('Sougni', 'sougni', 'sougni', 5)
on conflict (slug) do nothing;
