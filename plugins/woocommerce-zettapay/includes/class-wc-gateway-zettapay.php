<?php
/**
 * WooCommerce payment gateway for ZettaPay USDC.
 *
 * @package ZettaPay\WooCommerce
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

class WC_Gateway_ZettaPay extends WC_Payment_Gateway {

	const ID = 'zettapay';

	/** @var string */
	public $api_base;

	/** @var string */
	public $api_key;

	/** @var string */
	public $merchant_id;

	/** @var string */
	public $webhook_secret;

	/** @var string */
	public $environment;

	public function __construct() {
		$this->id                 = self::ID;
		$this->method_title       = __( 'ZettaPay (USDC)', 'zettapay-for-woocommerce' );
		$this->method_description = __(
			'Aceite USDC na Solana com settlement em segundos. Fees 0.30% — sem custódia, transferência direta payer → merchant.',
			'zettapay-for-woocommerce'
		);
		$this->has_fields         = false;
		$this->icon               = ZETTAPAY_WC_PLUGIN_URL . 'assets/icon.svg';
		$this->supports           = array( 'products' );

		$this->init_form_fields();
		$this->init_settings();

		$this->title          = (string) $this->get_option( 'title', __( 'Pagar com USDC (ZettaPay)', 'zettapay-for-woocommerce' ) );
		$this->description    = (string) $this->get_option( 'description', '' );
		$this->enabled        = (string) $this->get_option( 'enabled', 'no' );
		$this->environment    = (string) $this->get_option( 'environment', 'production' );
		$this->api_base       = (string) $this->get_option( 'api_base', ZettaPay_Api_Client::DEFAULT_BASE_URL );
		$this->api_key        = (string) $this->get_option( 'api_key', '' );
		$this->merchant_id    = (string) $this->get_option( 'merchant_id', '' );
		$this->webhook_secret = (string) get_option( 'zettapay_wc_webhook_secret', '' );

		add_action(
			'woocommerce_update_options_payment_gateways_' . $this->id,
			array( $this, 'process_admin_options' )
		);
	}

	public function init_form_fields(): void {
		$webhook_url = esc_url_raw( rest_url( 'zettapay/v1/webhook' ) );

		$this->form_fields = array(
			'enabled'        => array(
				'title'   => __( 'Ativar/Desativar', 'zettapay-for-woocommerce' ),
				'type'    => 'checkbox',
				'label'   => __( 'Aceitar pagamentos USDC via ZettaPay', 'zettapay-for-woocommerce' ),
				'default' => 'no',
			),
			'title'          => array(
				'title'       => __( 'Título no checkout', 'zettapay-for-woocommerce' ),
				'type'        => 'text',
				'description' => __( 'Como o método aparece para o cliente.', 'zettapay-for-woocommerce' ),
				'default'     => __( 'Pagar com USDC (ZettaPay)', 'zettapay-for-woocommerce' ),
				'desc_tip'    => true,
			),
			'description'    => array(
				'title'       => __( 'Descrição no checkout', 'zettapay-for-woocommerce' ),
				'type'        => 'textarea',
				'description' => __( 'Texto explicativo logo abaixo do título.', 'zettapay-for-woocommerce' ),
				'default'     => __( 'USDC liquidado em segundos via Solana. Você precisa de uma carteira compatível (Phantom, Solflare).', 'zettapay-for-woocommerce' ),
			),
			'environment'    => array(
				'title'   => __( 'Ambiente', 'zettapay-for-woocommerce' ),
				'type'    => 'select',
				'options' => array(
					'production' => __( 'Produção (mainnet)', 'zettapay-for-woocommerce' ),
					'sandbox'    => __( 'Sandbox (devnet)', 'zettapay-for-woocommerce' ),
				),
				'default' => 'production',
			),
			'api_base'       => array(
				'title'       => __( 'API endpoint', 'zettapay-for-woocommerce' ),
				'type'        => 'text',
				'description' => __( 'Use o default a menos que você esteja em ambiente self-hosted.', 'zettapay-for-woocommerce' ),
				'default'     => ZettaPay_Api_Client::DEFAULT_BASE_URL,
				'desc_tip'    => true,
			),
			'merchant_id'    => array(
				'title'       => __( 'Merchant ID', 'zettapay-for-woocommerce' ),
				'type'        => 'text',
				'description' => __( 'Encontrado no dashboard ZettaPay → Configurações.', 'zettapay-for-woocommerce' ),
				'desc_tip'    => true,
			),
			'api_key'        => array(
				'title'       => __( 'API key', 'zettapay-for-woocommerce' ),
				'type'        => 'password',
				'description' => __( 'API key secreta do ZettaPay. Nunca compartilhe.', 'zettapay-for-woocommerce' ),
				'desc_tip'    => true,
			),
			'webhook_url'    => array(
				'title'             => __( 'URL do webhook', 'zettapay-for-woocommerce' ),
				'type'              => 'text',
				'default'           => $webhook_url,
				'custom_attributes' => array( 'readonly' => 'readonly' ),
				'description'       => __( 'Cadastre esta URL no dashboard ZettaPay para receber confirmações de pagamento.', 'zettapay-for-woocommerce' ),
			),
			'webhook_secret' => array(
				'title'             => __( 'Webhook signing secret', 'zettapay-for-woocommerce' ),
				'type'              => 'text',
				'default'           => (string) get_option( 'zettapay_wc_webhook_secret', '' ),
				'custom_attributes' => array( 'readonly' => 'readonly' ),
				'description'       => __( 'Compartilhe este segredo com o dashboard ZettaPay para validar assinaturas.', 'zettapay-for-woocommerce' ),
			),
		);
	}

	public function is_available(): bool {
		if ( 'yes' !== $this->enabled ) {
			return false;
		}
		if ( empty( $this->api_key ) || empty( $this->merchant_id ) ) {
			return false;
		}
		return parent::is_available();
	}

	/**
	 * Build a payment intent on ZettaPay and redirect the buyer to the hosted
	 * pay URL where they sign the on-chain transfer with their wallet.
	 *
	 * @param int $order_id WooCommerce order id.
	 * @return array
	 */
	public function process_payment( $order_id ) {
		$order = wc_get_order( $order_id );
		if ( ! $order ) {
			wc_add_notice( __( 'Order not found.', 'zettapay-for-woocommerce' ), 'error' );
			return array( 'result' => 'failure' );
		}

		$client  = new ZettaPay_Api_Client( $this->api_base, $this->api_key, $this->merchant_id );
		$payload = array(
			'merchant_id'     => $this->merchant_id,
			'amount'          => $order->get_total(),
			'currency'        => $order->get_currency(),
			'order_ref'       => (string) $order->get_id(),
			'idempotency_key' => 'wc_' . $order->get_id() . '_' . $order->get_order_key(),
			'metadata'        => array(
				'source'        => 'woocommerce',
				'wc_order_id'   => $order->get_id(),
				'wc_order_key'  => $order->get_order_key(),
				'customer_email' => $order->get_billing_email(),
			),
			'return_url'      => $this->get_return_url( $order ),
			'cancel_url'      => $order->get_cancel_order_url_raw(),
		);

		$result = $client->create_payment( $payload );
		if ( is_wp_error( $result ) ) {
			$order->add_order_note(
				sprintf(
					/* translators: %s: error message */
					__( 'Falha ao criar intent ZettaPay: %s', 'zettapay-for-woocommerce' ),
					$result->get_error_message()
				)
			);
			wc_add_notice( __( 'Não foi possível iniciar o pagamento ZettaPay. Tente novamente.', 'zettapay-for-woocommerce' ), 'error' );
			return array( 'result' => 'failure' );
		}

		$pay_url    = isset( $result['pay_url'] ) ? esc_url_raw( $result['pay_url'] ) : '';
		$payment_id = isset( $result['id'] ) ? sanitize_text_field( $result['id'] ) : '';

		if ( ! $pay_url ) {
			wc_add_notice( __( 'Resposta inválida do ZettaPay.', 'zettapay-for-woocommerce' ), 'error' );
			return array( 'result' => 'failure' );
		}

		if ( $payment_id ) {
			$order->update_meta_data( '_zettapay_payment_id', $payment_id );
		}
		$order->update_status( 'pending', __( 'Aguardando confirmação on-chain ZettaPay.', 'zettapay-for-woocommerce' ) );
		$order->save();

		return array(
			'result'   => 'success',
			'redirect' => $pay_url,
		);
	}
}
