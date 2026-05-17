# legacy-solana

DEPRECATED. ZettaPay pivotou pra BTC + USDC (Base/Polygon/Ethereum) em 2026-05.
Este codigo NAO e mantido. Existe apenas pra historia e potencial revivido futuro.
Nao adicionar features novas aqui.

## Conteudo

| Caminho | Origem |
| --- | --- |
| `programs/zettapay/` | Programa Anchor on-chain (PDA invoice + sweep) |
| `programs/zettapay-core/` | Native Solana program (sem Anchor) |
| `services/onchain_indexer.ts` | Indexador Helius / RPC para PaymentRecord |
| `services/program_monitor.ts` | Cron 24/7 que avalia saude do programa |
| `routes/indexer.ts` | Webhook receiver + backfill HTTP |
| `solana/` | Helpers RPC, IDL, PDA derivation, memo program |
| `public/pay-legacy.html` | Antigo checkout `solana:` URI |
| `test/` | Testes vitest dos modulos acima |

## Arquitetura atual (post-pivot)

- **Bitcoin (BTC)** on-chain, HD wallet per-invoice
- **USDC em EVMs:** Base (MVP), Polygon, Ethereum
- Listener watcha o endereco via RPC publico — sem reference field, sem memo

Veja o README na raiz do repo para a stack viva.
