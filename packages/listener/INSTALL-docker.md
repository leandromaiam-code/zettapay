# Instalar o @zettapay/listener (self-hosted, qualquer VPS)

Roda em **qualquer VPS com Docker** — DigitalOcean, Hetzner, AWS, etc., com
ou sem EasyPanel/Portainer. O listener fica na rede interna do Docker; o seu
app o alcança por `http://zettapay-listener:8787`. Nada é exposto na internet.

## Arquitetura

```
   VPS do merchant (Docker)
   ┌─────────────────────────────────────────────┐
   │  [seu app]  ──http interno──>  [zettapay-listener]  │
   │  (container)   rede Docker        (container)        │
   │      │                                              │
   └──────│───────────────────────────────────────────────┘
          │ HTTPS (proxy que você já tem: Traefik/nginx/EasyPanel)
       cliente final  →  vê só o SEU domínio
```

- **xpub fica só no listener** (server-side). Nunca no browser.
- **Listener nunca exposto** — só o seu app fala com ele, pela rede interna.
- **Non-custodial**: BTC vai direto pra sua carteira (derivada do xpub).

## Passo a passo

### 1. Suba o listener

**Opção A — docker compose** (recomendado):

```bash
# baixe os exemplos
curl -O https://raw.githubusercontent.com/leandromaiam-code/zettapay/main/packages/listener/docker-compose.example.yml
curl -O https://raw.githubusercontent.com/leandromaiam-code/zettapay/main/packages/listener/.env.example

mv docker-compose.example.yml docker-compose.yml
cp .env.example .env
# edite .env: MERCHANT_XPUB, MERCHANT_WEBHOOK_URL, MERCHANT_WEBHOOK_SECRET, ZETTAPAY_API_KEY

# IMPORTANTE: ajuste `networks.app-net` para a rede onde o SEU app roda.
docker compose up -d
```

**Opção B — docker run**:

```bash
docker run -d --name zettapay-listener \
  --network <rede-do-seu-app> \
  --restart unless-stopped \
  -v zettapay-data:/data \
  -e MERCHANT_XPUB=zpub... \
  -e MERCHANT_WEBHOOK_URL=https://seu-app.com/api/zp/webhook \
  -e MERCHANT_WEBHOOK_SECRET=segredo-forte \
  -e ZETTAPAY_API_KEY=chave-forte \
  ghcr.io/leandromaiam-code/zettapay-listener:latest
```

Na primeira subida o container faz o seed do merchant a partir das env vars.
Sem passos manuais.

### 2. Crie uma invoice (do SEU backend)

```js
// no backend do seu app (server-side)
const r = await fetch('http://zettapay-listener:8787/invoice', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-ZettaPay-Api-Key': process.env.ZETTAPAY_API_KEY,
  },
  body: JSON.stringify({ amount_sats: 2000, memo: 'Pedido #123' }),
});
const inv = await r.json();
// inv.receive_address  -> mostre o QR (inv.qr_uri) pro cliente
// inv.invoice_id       -> guarde ligado ao seu pedido/usuário
```

### 3. Consulte o status (polling do frontend)

```js
const s = await fetch(`http://zettapay-listener:8787/invoice/${id}`); // via proxy do seu app
// s.status: 'pending' | 'seen' | 'confirmed' | 'expired'
```

### 4. Receba a confirmação (webhook)

O listener faz POST em `MERCHANT_WEBHOOK_URL` quando o pagamento é detectado/
confirmado, assinado com HMAC-SHA256 (header `X-ZettaPay-Signature`). Valide a
assinatura com o `MERCHANT_WEBHOOK_SECRET` e libere o pedido.

## Segurança

- `xpub` (chave pública) só no listener. Ninguém deriva o xpub a partir dos
  endereços/faturas — derivação é mão única.
- `POST /invoice` exige `X-ZettaPay-Api-Key`.
- Webhook assinado (HMAC) — valide sempre antes de liberar.
- Listener sem porta pública: comunicação só pela rede interna do Docker.

## Health

```bash
docker exec zettapay-listener node /app/dist/cli/healthcheck.js
# ou, de dentro da rede: curl http://zettapay-listener:8787/health
```
