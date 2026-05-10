<?php
/**
 * Webhook handler — verifies ZettaPay's HMAC-SHA256 signature and applies the
 * status transition to the WooCommerce order.
 *
 * Signature scheme (matches packages/api/src/lib/webhook-signature.ts):
 *   - Header  X-ZettaPay-Signature: sha256=<hex>
 *   - Header  X-ZettaPay-Timestamp: <unix-ms>
 *   - Header  X-ZettaPay-Event-Id:  <unique id, used for idempotency>
 *   - HMAC    hmac_sha256(secret, "<timestamp>.<raw_body>") → hex
 *   - Skew    timestamps drifting >300s from now are rejected.
 *
 * @package ZettaPay\WooCommerce
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

class ZettaPay_Webhook_Handler {

	const ROUTE_NAMESPACE = 'zettapay/v1';
	const ROUTE_PATH      = '/webhook';
	const TOLERANCE_SEC   = 300;
	const SIG_PREFIX      = 'sha256=';

	public static function register_routes(): void {
		add_action(
			'rest_api_init',
			static function () {
				register_rest_route(
					self::ROUTE_NAMESPACE,
					self::ROUTE_PATH,
					array(
						'methods'             => 'POST',
						'callback'            => array( __CLASS__, 'handle' ),
						'permission_callback' => '__return_true',
					)
				);
			}
		);
	}

	public static function handle( WP_REST_Request $request ) {
		$secret = (string) get_option( 'zettapay_wc_webhook_secret', '' );
		if ( '' === $secret ) {
			return new WP_REST_Response( array( 'error' => 'webhook_not_configured' ), 503 );
		}

		$raw_body  = $request->get_body();
		$signature = (string) $request->get_header( 'x_zettapay_signature' );
		$timestamp = (string) $request->get_header( 'x_zettapay_timestamp' );
		$event_id  = (string) $request->get_header( 'x_zettapay_event_id' );

		$verification = self::verify_signature( $secret, $raw_body, $timestamp, $signature );
		if ( true !== $verification ) {
			return new WP_REST_Response( array( 'error' => $verification ), 401 );
		}

		if ( '' !== $event_id && self::has_processed_event( $event_id ) ) {
			return new WP_REST_Response( array( 'ok' => true, 'idempotent' => true ), 200 );
		}

		$payload = json_decode( $raw_body, true );
		if ( ! is_array( $payload ) ) {
			return new WP_REST_Response( array( 'error' => 'invalid_payload' ), 400 );
		}

		$result = self::dispatch_event( $payload );

		if ( '' !== $event_id ) {
			self::mark_event_processed( $event_id );
		}

		return new WP_REST_Response( $result, 200 );
	}

	/**
	 * Verify the HMAC-SHA256 signature against the timestamped payload.
	 *
	 * @return true|string `true` on success, otherwise a short failure code.
	 */
	public static function verify_signature( string $secret, string $payload, string $timestamp, string $signature_header ) {
		if ( '' === $signature_header ) {
			return 'missing_signature';
		}
		if ( '' === $timestamp ) {
			return 'missing_timestamp';
		}
		if ( ! is_numeric( $timestamp ) ) {
			return 'invalid_timestamp';
		}

		$now_ms     = (int) round( microtime( true ) * 1000 );
		$ts_numeric = (int) $timestamp;
		if ( abs( $now_ms - $ts_numeric ) > self::TOLERANCE_SEC * 1000 ) {
			return 'timestamp_out_of_tolerance';
		}

		$provided = self::strip_prefix( $signature_header );
		if ( '' === $provided || ! ctype_xdigit( $provided ) || ( strlen( $provided ) % 2 ) !== 0 ) {
			return 'malformed_signature';
		}

		$expected = hash_hmac( 'sha256', $timestamp . '.' . $payload, $secret );
		if ( ! hash_equals( $expected, strtolower( $provided ) ) ) {
			return 'signature_mismatch';
		}
		return true;
	}

	private static function strip_prefix( string $signature ): string {
		$signature = trim( $signature );
		if ( 0 === strpos( $signature, self::SIG_PREFIX ) ) {
			return substr( $signature, strlen( self::SIG_PREFIX ) );
		}
		return $signature;
	}

	private static function dispatch_event( array $payload ): array {
		$type      = isset( $payload['event'] ) ? (string) $payload['event'] : ( isset( $payload['type'] ) ? (string) $payload['type'] : '' );
		$data      = isset( $payload['data'] ) && is_array( $payload['data'] ) ? $payload['data'] : $payload;
		$order_ref = isset( $data['order_ref'] ) ? (string) $data['order_ref'] : '';
		if ( '' === $order_ref && isset( $data['metadata']['wc_order_id'] ) ) {
			$order_ref = (string) $data['metadata']['wc_order_id'];
		}

		if ( '' === $order_ref ) {
			return array( 'ok' => false, 'reason' => 'missing_order_ref' );
		}

		$order = wc_get_order( (int) $order_ref );
		if ( ! $order ) {
			return array( 'ok' => false, 'reason' => 'order_not_found', 'order_ref' => $order_ref );
		}

		switch ( $type ) {
			case 'payment.completed':
			case 'payment.confirmed':
				if ( ! $order->is_paid() ) {
					$tx = isset( $data['tx_signature'] ) ? sanitize_text_field( (string) $data['tx_signature'] ) : '';
					$order->payment_complete( $tx );
					if ( $tx ) {
						$order->add_order_note(
							sprintf(
								/* translators: %s: Solana tx signature */
								__( 'ZettaPay payment confirmed on-chain. tx=%s', 'zettapay-for-woocommerce' ),
								$tx
							)
						);
					}
				}
				return array( 'ok' => true, 'status' => 'completed' );

			case 'payment.failed':
				$order->update_status( 'failed', __( 'ZettaPay reported payment failed.', 'zettapay-for-woocommerce' ) );
				return array( 'ok' => true, 'status' => 'failed' );

			case 'payment.refunded':
				$order->update_status( 'refunded', __( 'ZettaPay processed a refund.', 'zettapay-for-woocommerce' ) );
				return array( 'ok' => true, 'status' => 'refunded' );

			default:
				$order->add_order_note(
					sprintf(
						/* translators: %s: event type */
						__( 'Webhook ZettaPay recebido (sem ação): %s', 'zettapay-for-woocommerce' ),
						$type ?: 'unknown'
					)
				);
				return array( 'ok' => true, 'status' => 'noop', 'event' => $type );
		}
	}

	private static function event_option_key( string $event_id ): string {
		return 'zettapay_wc_evt_' . substr( hash( 'sha256', $event_id ), 0, 32 );
	}

	private static function has_processed_event( string $event_id ): bool {
		return false !== get_option( self::event_option_key( $event_id ), false );
	}

	private static function mark_event_processed( string $event_id ): void {
		update_option( self::event_option_key( $event_id ), time(), false );
	}
}
