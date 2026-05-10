# ZettaPay para Wix

Submissão da app ZettaPay no **Wix App Market** + módulos prontos para
**Wix Velo**. Aceite USDC liquidados em segundos via Solana, fees 10x
menores que cartão, sem custódia.

## O que está incluído

```
plugins/wix-zettapay/
├── app.json                            # manifest da App Market
├── velo/
│   ├── backend/zettapay.web.js         # módulo backend Velo
│   └── page/zettapay-checkout.js       # script de página Velo
└── README.md
```

A API ZettaPay também serve estes ficheiros dinamicamente
(com o `merchant_id` injectado):

| Caminho                                    | Conteúdo                                          |
| ------------------------------------------ | ------------------------------------------------- |
| `GET /wix/manifest.json`                   | Manifest oficial submetido à Wix App Market.      |
| `GET /wix/velo/backend/<merchantId>`       | Módulo backend Velo já personalizado.             |
| `GET /wix/velo/page`                       | Script de página Velo (sem dados do merchant).    |
| `GET /wix/app/info`                        | Metadados de onboarding consumidos pelo dashboard.|

## Instalação no Wix Editor (Velo)

1. Abra o site Wix → **Dev Mode** → ative o Velo by Wix.
2. Crie o ficheiro `backend/zettapay.web.js` e cole o conteúdo de
   `velo/backend/zettapay.web.js` (ou faça download de
   `/wix/velo/backend/<merchantId>` para já vir pré-configurado).
3. Adicione um **Lightbox** chamado `zettapay-checkout` contendo um
   elemento HTML iframe vinculado à propriedade `url`.
4. Na página onde o checkout deve aparecer, adicione um Botão com id
   `#zpPayButton` e cole `velo/page/zettapay-checkout.js` no código da
   página.
5. Faça **Preview**, execute um pagamento de teste e submeta a sua app
   pelo painel **Wix App Market** apontando para o seu `manifest.json`.

## Submissão à App Market

`app.json` é o manifesto canónico do módulo Wix App Market. Para uma
submissão pública, use `https://api.zettapay.io/wix/manifest.json` —
esta versão dinâmica garante que `version`, `oauth.*` e `endpoints.*`
ficam sempre alinhados com a versão deployada da API.

Permissões pedidas:

- `wix.fetch.outbound` — para chamar a API ZettaPay a partir do backend.
- `wix.users.read` — para associar pagamentos ao utilizador Wix logado.
- `wix.stores.orders.read` — para correlacionar pagamentos com encomendas
  Wix Stores quando o merchant usa o módulo de e-commerce nativo do Wix.

Webhooks recebidos pelo merchant via `webhook.url` cobrem
`payment.completed`, `payment.failed` e `payment.refunded` — assinados com
HMAC-SHA256 (consulte a documentação do header `x-zettapay-signature`).

## Suporte

- Site: https://zettapay.io/wix
- Documentação: https://zettapay.io/docs/integrations/wix
- Contacto: support@zettapay.io
