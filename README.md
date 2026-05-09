# Veridian Fabric · V0

> **Forjar empresas autônomas.** Chassi multi-tenant onde cada workspace = um produto autônomo. Premissas, hipóteses, journal e métricas alimentadas via n8n.

Veridian Fabric é o módulo de auto-evolução de produto do **Veridian AI Venture**. Esta é a V0: chassi + telas + integração n8n via webhooks. AutoDev real e A/B engine ficam pra V1+.

---

## Stack

- **Next.js 16** (App Router · React 19 · Server Components · Server Actions)
- **TypeScript** strict mode
- **Supabase** (auth via magic link · Postgres · RLS)
- **Tailwind CSS 4** (zero-config, tokens em `globals.css`)
- **shadcn-style** UI (Radix primitives + class-variance-authority)
- **react-markdown** para preview de premissas
- **n8n** orquestra rotinas externas, conversa via HTTP

---

## Design system — Veridian Light Parchment

Aplicado rigorosamente seguindo o **Manual de Marca Veridian V2 (Artifact Edition)**.

### Cores (CSS variables em `globals.css`)

| Token | Hex | Uso |
|---|---|---|
| `--color-parchment` | `#EFECE0` | bg dominante (NUNCA `#FFF`) |
| `--color-linen` | `#DDD8C9` | divisores, cards de segundo nível |
| `--color-ink` | `#14231D` | texto principal (NUNCA `#000`) |
| `--color-stone` | `#5C6560` | texto secundário, metadata |
| `--color-forest` | `#1E3B33` | bg escuro (sidebar, cards de status) |
| `--color-forest-deep` | `#14231D` | hover/active sobre forest |
| `--color-emerald` | `#2D5D4E` | acentos secundários |
| `--color-seafoam` | `#A8C4B8` | texto sobre forest |
| `--color-celadon` | `#C9D8CF` | texto terciário sobre forest |
| `--color-brass-light` | `#E8C88A` | hierarquia leve |
| `--color-brass` | `#C9A56B` | hierarquia média |
| `--color-brass-deep` | `#9B7F4E` | ação primária, hierarquia |

### Tipografia (Google Fonts via `next/font`)

- **Cormorant Garamond** (Light 300, Regular 400, Italic) — títulos, headers
- **Inter** (400, 500) — corpo, UI, dados
- **JetBrains Mono** (400, 500) — eyebrows, tags, IDs, timestamps

### Princípios

- Botão primário: `bg-forest text-parchment` em pill (`rounded-full`). NUNCA brass sólido.
- Botão secundário: borda brass-deep, transparente.
- Cards de status: forest com `border-l-2 border-brass`.
- Numeração de seções em algarismo romano itálico Cormorant brass.
- Eyebrows mono CAIXA ALTA com `tracking-[0.2em]`.
- Vocabulário: forjar, substrato, tese, hipótese, premissa, autonomia, journal.

---

## Schema Supabase

Convenção: prefixo `fabric_<submodulo>_<recurso>`.

| Submódulo | Tabelas |
|---|---|
| `core` | workspaces, members |
| `layer0` | premissas (canônico) |
| `layer1` | hipóteses (backlog) |
| `signals` | metrics |
| `audit` | journal |

Aplicar com:

```bash
psql $DATABASE_URL -f supabase/migrations/0001_init.sql
```

Ou via Supabase Management API (já aplicado no projeto Vortex Supabase, mesma org Veridian).

RLS ativo em todas as tabelas. Isolamento garantido por `fabric_fn_has_access(workspace_id)`.

Bootstrap automático: ao criar workspace, o owner vira member, premissa vazia é gerada e entrada `workspace_created` aparece no journal.

---

## Setup local

### 1. Variáveis de ambiente

Copie `.env.example` para `.env.local` e preencha:

```
NEXT_PUBLIC_SUPABASE_URL=https://<project>.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon key>
SUPABASE_SERVICE_ROLE_KEY=<service role>

# Token aleatório para autenticar n8n em /api/n8n/ingest
# Gerar com: openssl rand -hex 32
FABRIC_INGEST_TOKEN=

# Webhook URL do n8n (opcional na V0 — se vazio, só loga)
N8N_WEBHOOK_URL=https://n8n.example/webhook/...
```

### 2. Install + run

```bash
npm install
npm run dev
```

App disponível em `http://localhost:3000`.

### 3. Primeiro acesso

1. Acesse `/login`, digite seu email, clique em "Receber link mágico"
2. Clique no link recebido — vai cair em `/auth/callback` e redirecionar
3. Sem workspace? Vai pra `/new`. Crie o primeiro.
4. Sidebar permite trocar entre workspaces.

---

## Integração n8n

Filosofia: **Fabric não roda cron**. Toda rotina externa (NPS, churn, benchmark) é orquestrada pelo n8n e empurrada pra cá via webhook.

### Inbound: n8n → Fabric

`POST /api/n8n/ingest` — header `X-Fabric-Token: <FABRIC_INGEST_TOKEN>`.

```json
{
  "workspace_slug": "knexo",
  "kind": "hipotese | metric | journal",
  "data": { ... }
}
```

#### `kind: "hipotese"` — insere em `fabric_layer1_hipoteses` (status `pending`)

```json
{
  "workspace_slug": "knexo",
  "kind": "hipotese",
  "data": {
    "source": "nps",
    "title": "Detrator: integração lenta",
    "body": "5 clientes citaram lentidão na sync inicial",
    "score": 5
  }
}
```

#### `kind: "metric"` — upsert em `fabric_signals_metrics`

```json
{
  "workspace_slug": "knexo",
  "kind": "metric",
  "data": {
    "captured_at": "2026-05-03",
    "nps": 42,
    "churn_rate": 3.2,
    "active_users": 1280
  }
}
```

#### `kind: "journal"` — insere em `fabric_audit_journal`

```json
{
  "workspace_slug": "knexo",
  "kind": "journal",
  "data": {
    "event_type": "github_issue_created",
    "payload": { "hipotese_id": "...", "issue_url": "https://..." },
    "actor": "n8n"
  }
}
```

### Outbound: Fabric → n8n

Quando uma hipótese é **aprovada** (ou rejeitada, ou premissa atualizada), Fabric faz `POST` para `N8N_WEBHOOK_URL`:

```json
{
  "event": "hipotese.approved",
  "workspace": { "id": "...", "slug": "knexo" },
  "hipotese": { "id": "...", "title": "...", "body": "...", "source": "nps" }
}
```

n8n decide o que fazer (criar issue no GitHub, notificar Slack, disparar AutoDev). Fabric não precisa saber.

### Health check

`GET /api/n8n/webhook-test` — retorna contratos e timestamp.

---

## Workflows n8n recomendados (3 iniciais)

### 1. NPS Ingest (diário, 06:00 BRT)
Schedule → fonte externa de NPS → loop por workspace → POST `/api/n8n/ingest` (`kind: metric`) + 1 hipótese por detrator com comentário (`kind: hipotese`, `source: nps`).

### 2. Churn Ingest (semanal, segunda 07:00 BRT)
Schedule → query churn cohort → POST `kind: metric` + top 3 razões como hipóteses (`source: churn`).

### 3. Hipótese aprovada → GitHub Issue
Webhook (URL = `N8N_WEBHOOK_URL`) → Function (mapa workspace_slug → repo) → GitHub Create Issue → callback POST `kind: journal` (`event_type: github_issue_created`, `issue_url`).

Detalhamento completo no `FABRIC_V0_BUILD_PROMPT`.

---

## Estrutura

```
veridian-fabric/
├── src/
│   ├── app/
│   │   ├── layout.tsx               root layout (fontes Cormorant + Inter + Mono)
│   │   ├── page.tsx                 redireciona pro último workspace ou /new
│   │   ├── not-found.tsx
│   │   ├── globals.css              tokens Veridian
│   │   ├── auth/sign-out/route.ts
│   │   ├── (auth)/
│   │   │   ├── login/{page,login-form,actions}
│   │   │   └── auth/callback/route.ts
│   │   ├── (app)/
│   │   │   ├── new/{page,new-workspace-form,actions}
│   │   │   └── [workspace]/
│   │   │       ├── layout.tsx       sidebar + valida acesso
│   │   │       ├── page.tsx         overview (KPIs + journal preview)
│   │   │       ├── premissas/       editor markdown com preview
│   │   │       ├── backlog/         lista hipóteses + aprovar/rejeitar/adiar
│   │   │       ├── journal/         feed cronológico read-only
│   │   │       ├── metricas/        cards KPI + tabela histórica
│   │   │       └── settings/        identidade + members
│   │   └── api/n8n/
│   │       ├── ingest/route.ts      POST com X-Fabric-Token
│   │       └── webhook-test/route.ts ping
│   ├── components/
│   │   ├── ui/                      button, input, textarea, card, badge
│   │   ├── sidebar.tsx
│   │   ├── workspace-switcher.tsx
│   │   ├── eyebrow.tsx
│   │   ├── section-header.tsx       eyebrow + Cormorant + numeração romana
│   │   ├── pull-quote.tsx
│   │   ├── journal-item.tsx
│   │   ├── hipotese-row.tsx
│   │   └── kpi-card.tsx
│   ├── lib/
│   │   ├── supabase/{client,server,middleware}.ts
│   │   ├── utils.ts                 cn, formatRelativeDate, toRoman
│   │   ├── types.ts
│   │   └── n8n.ts                   notifyN8n outbound
│   └── middleware.ts                refresh sessão Supabase
├── supabase/migrations/0001_init.sql
└── README.md
```

---

## Constraints (V0)

- **Sem features extras.** Sem A/B engine. Sem AutoDev. Sem billing.
- **PT-BR em toda a UI.**
- **Server-first.** Client components só onde houver interação.
- **Sem console.log em produção.**

---

## Deploy

```bash
vercel deploy --prod
```

Variáveis de ambiente no Vercel (Settings → Environment Variables):
- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `FABRIC_INGEST_TOKEN`
- `N8N_WEBHOOK_URL` (opcional)

Supabase Auth → URL Configuration → Redirect URLs: adicionar `https://<vercel-domain>/auth/callback`.

---

## Versão

**V0 · Artifact Edition · MMXXVI** — *forjado com intenção*
