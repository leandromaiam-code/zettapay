<?php
/**
 * Thin HTTP client for the ZettaPay backend.
 *
 * @package ZettaPay\WooCommerce
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

class ZettaPay_Api_Client {

	const DEFAULT_BASE_URL = 'https://api.zettapay.io';

	/** @var string */
	private $api_base;

	/** @var string */
	private $api_key;

	/** @var string */
	private $merchant_id;

	public function __construct( string $api_base, string $api_key, string $merchant_id ) {
		$this->api_base    = rtrim( $api_base ?: self::DEFAULT_BASE_URL, '/' );
		$this->api_key     = $api_key;
		$this->merchant_id = $merchant_id;
	}

	/**
	 * Create a one-shot USDC payment intent. Returns the decoded JSON body on
	 * 2xx, or a WP_Error describing the upstream failure.
	 *
	 * @return array|WP_Error
	 */
	public function create_payment( array $payload ) {
		$body = wp_json_encode( $payload );
		if ( false === $body ) {
			return new WP_Error( 'zettapay_encode_error', __( 'Failed to encode payment payload.', 'zettapay-for-woocommerce' ) );
		}

		$response = wp_safe_remote_post(
			$this->api_base . '/pay',
			array(
				'timeout' => 15,
				'headers' => array(
					'content-type'         => 'application/json',
					'authorization'        => 'Bearer ' . $this->api_key,
					'x-zettapay-merchant'  => $this->merchant_id,
					'idempotency-key'      => $payload['idempotency_key'] ?? wp_generate_uuid4(),
				),
				'body'    => $body,
			)
		);

		if ( is_wp_error( $response ) ) {
			return $response;
		}

		$status = (int) wp_remote_retrieve_response_code( $response );
		$raw    = wp_remote_retrieve_body( $response );
		$json   = json_decode( $raw, true );

		if ( $status < 200 || $status >= 300 ) {
			return new WP_Error(
				'zettapay_upstream_error',
				sprintf(
					/* translators: %d: HTTP status from ZettaPay API */
					__( 'ZettaPay returned HTTP %d', 'zettapay-for-woocommerce' ),
					$status
				),
				array( 'status' => $status, 'body' => $json ?: $raw )
			);
		}

		return is_array( $json ) ? $json : array();
	}
}
