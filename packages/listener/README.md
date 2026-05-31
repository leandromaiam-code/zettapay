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

# USDC on Base
curl -X POST http://localhost:8787/invoice \
  -H "X-ZettaPay-Api-Key: $ZETTAPAY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"amount_usd":29,"chain":"base","metadata":{"ref":"user_42"}}'
```

Resposta (USDC modo endereço-fixo):
```json
{
  "invoice_id": "inv_...",
  "chain": "base",
  "asset": "USDC",
  "receive_address": "0xC4a7...",
  "amount_usdc": "29.000042",
  "nonce": 42,
  "mode": "fixed-address",
  "expires_at": "...",
  "qr_uri": "ethereum:0x833589...@8453/transfer?address=0xC4a7...&uint256=29000042"
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
| `MERCHANT_EVM_ADDRESS` | opcional | endereço fixo → USDC Base (carteiras sem xpub) |
| `MERCHANT_EVM_CHAINS` | opcional | csv de chains EVM (default `base`) |
| `BASE_RPC_URL` | opcional | RPC(s) da Base — csv; sobrescreve o quórum público |
| `ETHEREUM_RPC_URL` | opcional | RPC(s) da Ethereum — csv |
| `POLYGON_RPC_URL` | opcional | RPC(s) da Polygon — csv |
| `ZETTAPAY_RATE_LIMIT` | opcional | rate-limit `POST /invoice` (`<porIp>,<global>` por min; default `30,300`) |
| `STORAGE` | opcional | `json` (default) \| `sqlite` |
| `HEALTH_PORT` | opcional | porta da API (default `8787`) |

> **Produção:** com `NODE_ENV=production`, o listener **recusa iniciar** sem
> `ZETTAPAY_API_KEY` — o `POST /invoice` nunca fica aberto sem autenticação.

---

## Segurança (HR — Hard Rules)

- **HR-CUSTODY** — o listener recusa qualquer chave privada (xprv/zprv).
  Só aceita pública (xpub) ou endereço.
- **HR-WALLET-LESS** — nunca toca material de assinatura. Seus fundos só você move.
- **HR-PHONE-HOME** — só fala com mempool.space (BTC) e o RPC da chain (EVM).
  Nenhum dado de cliente sai pra terceiros.
- **Não custodial** — o BTC/USDC cai direto na sua carteira.

---

## Modelo de segurança e ameaças

Honestidade sobre o que o listener garante — e o que **você** precisa decidir.
Nada aqui muda a arquitetura: continua self-hosted, P2P, não custodial, sem
telemetria, sem terceiros.

### Confiança no RPC (USDC, modo endereço-fixo) — mitigada por quórum

No modo endereço-fixo o pagamento é confirmado lendo o log `Transfer` do ERC-20
num RPC público. Confiar num **único** RPC é risco: um endpoint malicioso ou com
bug poderia forjar uma confirmação e ativar uma fatura sem pagamento real.

Mitigação (v0.5.0): cada chain consulta uma **lista** de 2-3 RPCs públicos
independentes e exige **quórum** (≥2 de N) concordando no mesmo tx + valor +
maturidade antes de confirmar.

- 1 endpoint discorda / cai → usa os outros;
- só 1 responde → **não** confirma; fica "awaiting" e loga `rpc_quorum_degraded`;
- um endpoint forjando outro valor **nunca** alcança quórum.

**Alto valor: rode seu próprio node.** Aponte `BASE_RPC_URL` (ou
`ETHEREUM_RPC_URL` / `POLYGON_RPC_URL`) pro seu node — a lista vira 1-de-1 e o
node que você controla passa a ser a autoridade.

### Trade-off de privacidade: endereço-fixo vs xpub

- **Modo xpub** (`MERCHANT_XPUB_EVM`) deriva **um endereço por fatura** — melhor
  privacidade e atribuição direta por endereço. É o caminho preferido.
- **Modo endereço-fixo** (`MERCHANT_EVM_ADDRESS`) usa **um** endereço pra todas
  as faturas, identificando o pagador pelo **valor exato** (nonce nas casas
  decimais baixas do USDC). É o fallback pra carteiras que não exportam xpub
  (Phantom, MetaMask, App Base, Coinbase). Como o endereço é reutilizado, o
  histórico de pagamentos fica agregado num único endereço público. Os nonces
  são alocados de forma **não-sequencial** (passo coprimo + offset aleatório por
  boot) pra dificultar adivinhar o nonce de outra fatura. Pagamento com valor
  fora do nonce exato (a menos / a mais) **nunca** ativa fatura: vira
  `payment.orphan` (tolerância zero).

### Endpoint de criação de faturas

- `POST /invoice` exige `X-ZettaPay-Api-Key` quando `ZETTAPAY_API_KEY` está setado;
  a comparação é **constante no tempo** (sem vazar tamanho/prefixo por timing).
- Em `NODE_ENV=production` sem `ZETTAPAY_API_KEY`, o servidor **recusa iniciar**.
- **Rate-limit** em memória (default 30/min por IP, 300/min global, via
  `ZETTAPAY_RATE_LIMIT`) evita que um cliente abusivo esgote o pool de nonces ou
  inunde a criação de faturas. Excesso → HTTP 429.

---

## Docker

Veja `INSTALL-docker.md` — roda como container na sua rede Docker
(EasyPanel/Portainer/compose), nunca exposto, o app fala por localhost.

---

## Licença

MIT.
