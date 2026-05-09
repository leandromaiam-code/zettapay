# Veridian Starter — CLAUDE.md

## Sobre este produto
Este produto foi gerado pelo **Veridian Fabric** a partir de uma ideia/premissas. Editar este arquivo é editar a constituição do produto.

## Premissas centrais (Layer 0 — REGRAS, não sugestões)

### Stack
1. Next.js 16 (App Router, Server Components, Server Actions, Turbopack)
2. React 19 + TypeScript strict
3. Tailwind CSS 4 (sem styled-components, sem CSS-in-JS)
4. Supabase (Postgres + RLS + Auth + Realtime)
5. Vercel para deploy

### Arquitetura
6. Multi-tenant com schema dedicado: todas as tabelas vivem em `<slug>.*`
7. Supabase client configurado com `db: { schema: '<slug>' }` via env var
8. RLS sempre ativada — políticas usam `auth.uid()` direto
9. Auth compartilhada via `auth.users` (default Supabase)
10. Storage bucket: `workspaces/<slug>/`

### Brand & UX (Manual de Marca Veridian V2)
11. Paleta principal: Forest (#0a1612), Brass (#d4a961), Parchment (#f5e6c8)
12. Acentos: Emerald glow, Ember soft
13. Fontes: Cormorant Garamond (display/numerais), Manrope (body), Cinzel (uppercase brand), JetBrains Mono (code/eyebrows)
14. Glassmorphism dark + light theme toggle
15. Iron Man arc reactor animations (orb pulsante, stagger reveal, HUD scan)

### Performance
16. LCP < 2.5s, CLS < 0.1, TBT < 300ms
17. Bundle inicial < 200kb gzip
18. Imagens via next/image, lazy load por default
19. Server components por padrão (use 'use client' só quando necessário)

### Segurança & Compliance
20. Zero secrets em código — apenas env vars
21. Service role key NUNCA exposta no client
22. CSP headers configurados em middleware
23. Rate limit em endpoints sensíveis
24. Audit append-only em `audit_journal` para ações críticas

### Discipline de código
25. Código proprietário Veridian — NÃO mencionar Claude/Anthropic em commits, PRs, comentários
26. Brand voice: nunca "revolução", "disruption", "sinergia", "game-changer"
27. PT-BR como default de UI; i18n via dictionary keys, sem strings hardcoded
28. Total responsividade (desktop ultrawide → mobile → PWA installable)
29. Testes em paths críticos (auth, payments, RLS) — coverage > 70%

### AutoDev Cycle
30. Cada mission = 1 branch `auto/<id>-<slug>` → 1 PR → revisão (humana ou autônoma) → merge → deploy
31. Build verde é gate obrigatório antes de qualquer merge
32. Premissas Validator roda antes de spawn de mission e pode bloquear

## Como customizar este produto

### Adicionar premissa específica
Edite a seção **"Premissas específicas deste produto"** abaixo. Não remova as 32 acima.

### Trocar paleta
1. Edite `src/app/globals.css` os tokens `--color-*`
2. Edite `tailwind.config.ts` o themeExtend
3. Submeta como mission "Update brand palette"

### Adicionar tabela
1. Crie migration em `supabase/migrations/<timestamp>_<name>.sql`
2. Tabela DEVE ter `<slug>.<entity>` (schema dedicado)
3. RLS policy obrigatória usando `auth.uid()`

## Premissas específicas deste produto

> _(Esta seção é preenchida pelo Plan Squad durante Genesis. Edite para refinar.)_

- TODO: business model
- TODO: target persona
- TODO: differentiation

## Workflow de execução

1. **Mission entra** via dashboard ou autodev
2. **Premissas Validator** valida contra esta constituição
3. Se passa, **claude-code** spawna em `/opt/fabric-workspaces/<slug>/`
4. Implementa, builda local, abre PR
5. **Auto-review squad** valida diff vs premissas + smoke test no preview
6. **Auto-merge** se todos os gates verdes
7. **Vercel deploy** automático em produção

## Comandos úteis

```bash
npm run dev              # local
npm run build            # CI gate
npm run typecheck        # tsc --noEmit
npm run lint             # eslint
npm run test             # vitest
npx supabase migration new # nova migration
```

## Estrutura

```
src/
├── app/
│   ├── (app)/[workspace]/   # rotas autenticadas
│   ├── login/
│   ├── signup/
│   └── api/
├── components/              # reutilizáveis
├── lib/
│   ├── supabase/           # client schema-aware
│   ├── types.ts
│   └── utils.ts
└── middleware.ts            # auth gating
supabase/
└── migrations/             # 0001_init.sql (schema + RLS templates)
```
