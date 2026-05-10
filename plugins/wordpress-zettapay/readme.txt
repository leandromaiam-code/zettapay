=== ZettaPay ===
Contributors: zettapay
Tags: payments, usdc, solana, crypto, stablecoin, shortcode
Requires at least: 6.0
Tested up to: 6.7
Requires PHP: 7.4
Stable tag: 0.1.0
License: MIT
License URI: https://opensource.org/licenses/MIT

Aceite USDC liquidados em segundos via Solana em qualquer página WordPress. Funciona com ou sem WooCommerce.

== Description ==

ZettaPay é um plugin genérico para WordPress que adiciona um shortcode `[zettapay]` para inserir botões de checkout USDC em qualquer página, post ou widget de texto. Não requer WooCommerce — a integração é via link/iframe, sem custódia de carteira no servidor.

= Recursos =

* Shortcode `[zettapay merchant="merch_xxx" amount="10.00"]`
* Página de admin em **Configurações → ZettaPay** com Merchant ID default, label do botão e moeda
* Modal opcional: clique no botão abre o checkout em iframe sem sair da página
* Suporta success_url / cancel_url HTTPS e order_ref para correlacionar com o pedido interno do site
* CSS scopado em `.zettapay-*` para não conflitar com o tema
* Assets só são carregados em páginas que de fato usam o shortcode

= Uso básico =

1. Crie uma conta em [zettapay.io](https://zettapay.io) e copie seu Merchant ID.
2. Instale e ative o plugin.
3. Em **Configurações → ZettaPay**, cole o Merchant ID e ajuste o label.
4. Insira `[zettapay]` em qualquer página — usa o Merchant default — ou sobrescreva: `[zettapay merchant="merch_outro" amount="25.00"]`.

= Atributos suportados =

* `merchant` — Merchant ID (`merch_xxx` ou `@handle`); usa o default se omitido.
* `amount` — Valor decimal opcional (ex.: `10.00`).
* `currency` — Default `USDC`.
* `label` — Texto do botão.
* `order_ref` — Identificador interno do pedido (opcional, alfanum/`._:-`, máx. 64).
* `success_url`, `cancel_url` — URLs HTTPS de retorno (não-HTTPS é descartada).
* `modal` — `"true"` (default conforme settings) abre em iframe; `"false"` abre em nova aba.

== Frequently Asked Questions ==

= Preciso do WooCommerce? =

Não. Este plugin é independente. Para checkout dentro do flow nativo do Woo, instale **ZettaPay for WooCommerce** em vez disso.

= Custódia? =

Não custodiamos USDC. A transferência é direta payer → merchant na blockchain Solana.

= Sandbox? =

Aponte a URL "API base URL" da settings page para um endpoint de devnet.

== Changelog ==

= 0.1.0 =
* Versão inicial: shortcode genérico `[zettapay]`, settings page, modal opcional.
