# @zettapay/listener

> **Self-hosted, non-custodial crypto payment listener.**
> Aceite **Bitcoin** e **USDC** (Base) direto na sua infra. Sem custodian,
> sem taxa de protocolo, sem dar suas chaves pra ninguém.

[![npm](https://img.shields.io/npm/v/@zettapay/listener)](https://www.npmjs.com/package/@zettapay/listener)

O `zettapay-listener` roda na **sua** máquina, observa a blockchain pelos
endereços que **você** controla, e dispara um **webhook assinado (HMAC)** pro
seu backend quando um pagamento é confirmado. Suas chaves privadas nunca saem
da sua carteira — o listener só conhece a chave **pública** (xpub) ou um
endereço de recebimento.

---

## Quais pagamentos

| Rede | Token | Como deriva o endereço | Carteira do merchant |
|------|-------|------------------------|----------------------|
| **Bitcoin** | BTC | xpub/zpub BIP-84 → 1 endereço por fatura | Sparrow, Ledger, qualquer HD wallet |
| **USDC on Base** (modo xpub) | USDC | xpub EVM (m/44'/60'/0') → 1 endereço por fatura | Rabby, Ledger, MyEtherWallet |
| **USDC on Base** (modo endereço-fixo) | USDC | 1 endereço fixo + nonce no valor | **Phantom, MetaMask, Coinbase, App Base** |
| **USDT on Base** (modo endereço-fixo) | USDT | 1 endereço fixo + nonce no valor (mesmo padrão do USDC) | **Phantom, MetaMask, Coinbase, App Base** |

> **USDT é um segundo token na MESMA Base.** Contrato
> `0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2`, 6 decimais (igual ao USDC), então
> o nonce decimal funciona idêntico. O **mesmo** endereço fixo `0x` do merchant
> recebe USDC **e** USDT — a carteira dele aceita os dois. Cada fatura declara
> qual token espera (`asset: 'usdc' | 'usdt'`): um pagamento em USDT só casa
> fatura USDT e vice-versa, nunca se misturam. Mesma segurança (quorum RPC 2-de-N,
> confirmações, TTL 1h, orphan em under/overpayment) do USDC.

> **Por que 2 modos pra USDC?** As carteiras EVM populares (Phantom, MetaMask,
> App Base) **não exportam xpub**. Pra elas, o modo **endereço-fixo** usa um
> único endereço `0x` (que qualquer carteira mostra em "Receive") e identifica
> cada fatura por um **nonce embutido nas casas decimais** do valor
> (ex: `29.000042 USDC` → fatura nº 42). O cliente paga ~$29 e a fração de
> centavo identifica unicamente quem pagou.

---

## Instalação

```bash
npm install -g @zettapay/listener
```

### Setup interativo

```bash
zettapay-listener init
zettapay-listener start
```

O `init` pergunta tudo (xpub, webhook, storage). O `start` sobe o watcher +
a API HTTP + dispatcher de webhook numa porta só (default `8787`).

### Setup por flags (não-interativo)

```bash
zettapay-listener init \
  --xpub        <zpub BIP-84 do Bitcoin> \
  --xpub-evm    <xpub EVM m/44'/60'/0' (opcional — habilita USDC Base via derivação)> \
  --webhook-url https://seu-backend.com/api/zp/webhook \
  --storage     json \
  --force
zettapay-listener start
```

Para o **modo endereço-fixo** de USDC (carteiras sem xpub), use as env vars:

```bash
# no .env (ou EnvironmentFile do systemd)
MERCHANT_EVM_ADDRESS=0xSEU_ENDERECO_DE_RECEBIMENTO
MERCHANT_EVM_CHAINS=base
# opcional — quais tokens aceitar na Base (default: usdc). Para aceitar USDT também:
MERCHANT_EVM_TOKENS=usdc,usdt
```

---

## API HTTP

O listener expõe (default `http://localhost:8787`):

### `POST /invoice` — cria uma fatura
Header: `X-ZettaPay-Api-Key: <ZETTAPAY_API_KEY>` (se configurado)

```bash
# Bitcoin
curl -X POST http://localhost:8787/invoice \
  -H "X-ZettaPay-Api-Key: $ZETTAPAY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"amount_sats":2000,"memo":"Pedido #123","metadata":{"ref":"user_42"}}'

# USDC on Base (asset default)
curl -X POST http://localhost:8787/invoice \
  -H "X-ZettaPay-Api-Key: $ZETTAPAY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"amount_usd":29,"chain":"base","metadata":{"ref":"user_42"}}'

# USDT on Base (segundo token, mesmo endereço fixo)
curl -X POST http://localhost:8787/invoice \
  -H "X-ZettaPay-Api-Key: $ZETTAPAY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"amount_usd":29,"chain":"base","asset":"usdt","metadata":{"ref":"user_42"}}'
```

Resposta (modo endereço-fixo). `asset` e `token_address` refletem o token pedido
(`USDC` default ou `USDT`); o `qr_uri` aponta para o contrato correto:
```json
{
  "invoice_id": "inv_...",
  "chain": "base",
  "asset": "USDT",
  "token_address": "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2",
  "receive_address": "0xC4a7...",
  "amount_usdc": "29.000042",
  "nonce": 42,
  "mode": "fixed-address",
  "expires_at": "...",
  "qr_uri": "ethereum:0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2@8453/transfer?address=0xC4a7...&uint256=29000042"
}
```

> ⚠️ No modo endereço-fixo o cliente DEVE enviar o **valor exato**
> (`29.000042`). O nonce nas casas decimais é o que identifica a fatura.
> Valor redondo (`29.00`) vira pagamento órfão — não é ativado.

### `GET /invoice/:id` — consulta status

```bash
curl http://localhost:8787/invoice/inv_...
# { "status": "pending" | "detected" | "confirmed" | "expired", ... }
```

### `GET /health` — liveness

---

## Webhook (confirmação → seu backend)

Quando uma fatura confirma, o listener faz `POST` no
`MERCHANT_WEBHOOK_URL` com:

- Header `X-ZettaPay-Signature`: HMAC-SHA256(secret, **raw body**) em hex
- Header `X-ZettaPay-Timestamp`: `Date.now()` em **milissegundos**
- Body: `{ invoice_id, status, tx_hash, amount_*, confirmations, metadata }`

Valide a assinatura no seu backend antes de ativar qualquer coisa:

```js
import { createHmac, timingSafeEqual } from 'node:crypto';

function verify(rawBody, sig, ts, secret) {
  if (Math.abs(Date.now() - Number(ts)) > 5 * 60 * 1000) return false; // replay
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  return timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'));
}
```

> **Dica:** o webhook reusa o mesmo padrão de ativação que você já tem pro
> Stripe. "Crypto pago" = mesmo `upsert` de subscription que "Stripe pago".

---

## CLI

| Comando | O que faz |
|---------|-----------|
| `init` | wizard de setup (.env + merchant) |
| `start` | sobe watcher + API + webhook dispatcher |
| `verify-config` | valida o .env sem iniciar |
| `derive-address` | deriva um endereço de recebimento (read-only) |
| `create-invoice` | cria fatura via CLI |
| `healthcheck` | probe do health server (exit 0/1) |
| `migrate` | copia storage entre adapters |

---

## Variáveis de ambiente

| Var | Obrigatória | Descrição |
|-----|-------------|-----------|
| `MERCHANT_XPUB` | sim (pra BTC) | zpub/xpub BIP-84 |
| `MERCHANT_WEBHOOK_URL` | sim | URL https do seu backend |
| `MERCHANT_WEBHOOK_SECRET` | sim | segredo HMAC |
| `ZETTAPAY_API_KEY` | recomendado | protege o `POST /invoice` |
| `MERCHANT_XPUB_EVM` | opcional | xpub EVM → USDC Base via derivação |
| `MERCHANT_EVM_ADDRESS` | opcional | endereço fixo → USDC/USDT Base (carteiras sem xpub) |
| `MERCHANT_EVM_CHAINS` | opcional | csv de chains EVM (default `base`) |
| `MERCHANT_EVM_TOKENS` | opcional | csv de tokens na Base (default `usdc`; ex: `usdc,usdt`). USDT é Base-only |
| `BASE_RPC_URL` | opcional | RPC(s) da Base — csv pra quorum/node próprio (default: 3 RPCs públicos) |
| `ETHEREUM_RPC_URL` | opcional | RPC(s) Ethereum — csv (default: 3 RPCs públicos) |
| `POLYGON_RPC_URL` | opcional | RPC(s) Polygon — csv (default: 3 RPCs públicos) |
| `ZETTAPAY_RATE_LIMIT` | opcional | limite do `POST /invoice` — `30` ou `30,300` (ip,global) ou `off` (default `30,300`/min) |
| `STORAGE` | opcional | `json` (default) \| `sqlite` |
| `HEALTH_PORT` | opcional | porta da API (default `8787`) |

> **`NODE_ENV=production` + sem `ZETTAPAY_API_KEY` → o listener recusa subir.**
> Em produção um `POST /invoice` sem chave deixaria qualquer um criar faturas;
> defina a chave (qualquer segredo de alta entropia) ou rode sem `NODE_ENV` em dev.

---

## Segurança (HR — Hard Rules)

- **HR-CUSTODY** — o listener recusa qualquer chave privada (xprv/zprv).
  Só aceita pública (xpub) ou endereço.
- **HR-WALLET-LESS** — nunca toca material de assinatura. Seus fundos só você move.
- **HR-PHONE-HOME** — só fala com mempool.space (BTC) e o RPC da chain (EVM).
  Nenhum dado de cliente sai pra terceiros.
- **Não custodial** — o BTC/USDC cai direto na sua carteira.

---

## Security model & threat model

Honesto sobre o que o listener garante — e o que não garante. Tudo roda na sua
máquina; nenhum serviço novo, custódia ou telemetria é introduzido.

### No que o listener confia

- **Nós RPC públicos (EVM).** Confirmar um pagamento USDC depende de ler a chain
  via RPC. Um RPC malicioso poderia, em tese, forjar uma confirmação.
  **Mitigação (quorum):** cada chain tem uma *lista* de RPCs públicos
  independentes (2–3 por default). Uma confirmação só é aceita quando **≥2 RPCs
  concordam** no mesmo `(tx, valor, confirmações)`. Se só 1 responde, o
  pagamento fica `awaiting` e logamos `rpc_quorum_degraded` — **nunca**
  confirmamos com fonte única. Se um RPC discorda do valor, logamos
  `rpc_quorum_conflict` e não confirmamos.
  - **Alto valor → use seu próprio node.** Aponte `BASE_RPC_URL` (csv) pro seu
    nó (e opcionalmente um backup) — o override substitui os públicos. Com um
    único endpoint o quorum colapsa pra 1 (fonte confiável que é sua).
- **mempool.space (BTC).** A confirmação BTC usa o WebSocket/REST do
  mempool.space. Trade-off equivalente; rode sua própria instância pra remover a
  dependência.

### Trade-off de privacidade: xpub vs fixed-address

- **Modo xpub (recomendado):** cada fatura deriva um endereço único — máxima
  privacidade on-chain, nenhuma correlação entre pagamentos.
- **Modo fixed-address (carteiras sem xpub):** *uma* address recebe todas as
  faturas; o pagador é identificado pelo *valor exato* (nonce nos decimais
  baixos do USDC/USDT). Como todos os pagamentos caem no mesmo endereço, há
  **menos privacidade** (são correlacionáveis). Use xpub quando a carteira
  permitir. Quando vários tokens compartilham o endereço (USDC + USDT na Base),
  cada fatura registra o token esperado: um pagamento USDT só casa com uma fatura
  USDT, e vice-versa — nunca há cruzamento entre tokens.

### Front-running de valor & under/overpayment (fixed-address)

- **Nonce não-sequencial.** O nonce (1..9999) é alocado a partir de um ponto
  **aleatório** por fatura, então o valor exato de uma fatura não é adivinhável
  a partir de outra. A unicidade dentro do pool ativo `(chain, token, preço)` é
  garantida — cada token tem seu próprio espaço de nonces independente.
- **Tolerância ZERO.** Um valor recebido que não casa **exatamente** com nenhum
  nonce ativo vira `payment.orphan` (log + webhook) — nunca ativa uma fatura.
  Under/overpayment = orphan. A defesa contra reuso de nonce é a tela de
  checkout expirar (TTL 1h) escondendo o QR.

### Endurecimento da API (`POST /invoice`)

- **Auth constant-time.** A `X-ZettaPay-Api-Key` é comparada com
  `crypto.timingSafeEqual` (sem early-exit) — sem vazamento de timing.
- **Prod-guard.** `NODE_ENV=production` sem `ZETTAPAY_API_KEY` → recusa subir.
- **Rate-limit local.** Janela deslizante em memória (sem serviço externo):
  default 30 req/min por IP + 300/min global; excedeu → `429`. Configurável via
  `ZETTAPAY_RATE_LIMIT`.

### Idempotência de webhook

- `X-ZettaPay-Event-Id` é **determinístico** por `(invoice, status)`: uma
  re-detecção após restart produz o mesmo id, então seu backend deduplica.
  Reconciliação pull: `GET /invoice/:id` devolve `status` + `tx_hash`.

### O que NÃO fazemos

Sem custódia, sem KYC, sem telemetria, sem dependência paga, sem chamada a
domínio `zettapay.*` ou qualquer terceiro além de RPC público + mempool.space.

---

## Docker

Veja `INSTALL-docker.md` — roda como container na sua rede Docker
(EasyPanel/Portainer/compose), nunca exposto, o app fala por localhost.

---

## Licença

MIT.
