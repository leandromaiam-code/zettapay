<?php
/**
 * Plugin-wide options helper.
 *
 * Persisted as a single option (`ZETTAPAY_WP_OPTIONS_KEY`) so the entire
 * configuration is wiped cleanly on uninstall and the Settings API only has to
 * register one entry.
 *
 * @package ZettaPay\WordPress
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

class ZettaPay_Settings {

	const PAY_BASE_DEFAULT = 'https://api.zettapay.io';

	public static function defaults(): array {
		return array(
			'merchant_id'   => '',
			'pay_base'      => self::PAY_BASE_DEFAULT,
			'currency'      => 'USDC',
			'button_label'  => __( 'Pagar com USDC', 'zettapay' ),
			'open_in_modal' => 1,
		);
	}

	public static function get(): array {
		$stored = get_option( ZETTAPAY_WP_OPTIONS_KEY, array() );
		if ( ! is_array( $stored ) ) {
			$stored = array();
		}
		return array_merge( self::defaults(), $stored );
	}

	/**
	 * Sanitize an inbound options array (called by the Settings API).
	 */
	public static function sanitize( $input ): array {
		if ( ! is_array( $input ) ) {
			$input = array();
		}
		$current = self::get();

		$merchant = isset( $input['merchant_id'] ) ? self::sanitize_merchant_id( $input['merchant_id'] ) : '';
		$pay_base = isset( $input['pay_base'] ) ? self::sanitize_pay_base( $input['pay_base'] ) : '';
		$currency = isset( $input['currency'] ) ? self::sanitize_currency( $input['currency'] ) : '';
		$label    = isset( $input['button_label'] ) ? self::sanitize_label( $input['button_label'] ) : '';
		$modal    = ! empty( $input['open_in_modal'] ) ? 1 : 0;

		return array(
			'merchant_id'   => $merchant,
			'pay_base'      => $pay_base ?: self::PAY_BASE_DEFAULT,
			'currency'      => $currency ?: 'USDC',
			'button_label'  => $label ?: $current['button_label'],
			'open_in_modal' => $modal,
		);
	}

	/**
	 * Strips an optional leading "@" so users can paste either form. Allows
	 * `merch_xxx`, handles `@store`, or any alphanumeric-with-underscore id.
	 */
	public static function sanitize_merchant_id( $raw ): string {
		$value = is_string( $raw ) ? trim( $raw ) : '';
		if ( '' === $value ) {
			return '';
		}
		if ( '@' === substr( $value, 0, 1 ) ) {
			$value = substr( $value, 1 );
		}
		// Mirror the upstream API: alnum, dash, underscore, colon. Cap at 80.
		if ( ! preg_match( '/^[A-Za-z0-9_:-]{1,80}$/', $value ) ) {
			return '';
		}
		return $value;
	}

	public static function sanitize_pay_base( $raw ): string {
		$value = is_string( $raw ) ? trim( $raw ) : '';
		if ( '' === $value ) {
			return '';
		}
		$value = rtrim( $value, '/' );
		// Force https — plain http would leak the checkout intent and break
		// PSP-grade webhook expectations (premissa central #15).
		if ( ! preg_match( '#^https://#i', $value ) ) {
			return '';
		}
		$parsed = wp_parse_url( $value );
		if ( ! $parsed || empty( $parsed['host'] ) ) {
			return '';
		}
		return esc_url_raw( $value );
	}

	public static function sanitize_currency( $raw ): string {
		$value = is_string( $raw ) ? strtoupper( trim( $raw ) ) : '';
		$value = preg_replace( '/[^A-Z]/', '', $value ) ?? '';
		return substr( $value, 0, 8 );
	}

	public static function sanitize_label( $raw ): string {
		$value = is_string( $raw ) ? trim( wp_strip_all_tags( $raw ) ) : '';
		return mb_substr( $value, 0, 80 );
	}
}
