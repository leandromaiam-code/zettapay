=== ZettaPay for WooCommerce ===
Contributors: zettapay
Tags: woocommerce, payments, usdc, solana, crypto, stablecoin
Requires at least: 6.0
Tested up to: 6.7
Requires PHP: 7.4
Stable tag: 0.1.0
License: MIT
License URI: https://opensource.org/licenses/MIT

Aceite USDC na Solana no checkout WooCommerce. Settlement em segundos, fees 0.30%, sem custódia.

== Description ==

ZettaPay for WooCommerce adiciona um gateway de pagamento que aceita USDC liquidado on-chain via Solana. O cliente é redirecionado para uma página segura onde assina a transferência com sua carteira (Phantom, Solflare). Confirmações chegam à loja via webhook assinado HMAC-SHA256 e atualizam o status do pedido automaticamente.

= Recursos =

* Gateway WC_Gateway_ZettaPay com settings page nativa do WooCommerce
* Página hospedada de pagamento — sem código JavaScript no checkout da loja
* Webhook handler com verificação HMAC-SHA256 + tolerância de timestamp 5min
* Idempotência por event id (eventos repetidos não duplicam transição de status)
* Suporte a sandbox (Solana devnet) e produção (mainnet)

= Configuração =

1. Crie uma conta em https://zettapay.io e copie seu Merchant ID e API key.
2. Em WooCommerce → Settings → Payments, ative ZettaPay e cole as credenciais.
3. Copie a "URL do webhook" e o "Webhook secret" da settings page e cadastre no dashboard ZettaPay.

== Changelog ==

= 0.1.0 =
* Versão inicial: gateway, settings, webhook handler.
