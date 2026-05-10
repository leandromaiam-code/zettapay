<?php
/**
 * `[zettapay merchant="@store" amount="10.00"]` shortcode.
 *
 * Renders a hosted-checkout button that points at the ZettaPay pay base. The
 * actual checkout UI is loaded server-side by ZettaPay; the merchant's
 * WordPress site only needs the link/button + a small client script that
 * optionally opens it in a modal.
 *
 * @package ZettaPay\WordPress
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

class ZettaPay_Shortcode {

	const TAG = 'zettapay';

	public static function register(): void {
		add_shortcode( self::TAG, array( __CLASS__, 'render' ) );
		add_action( 'wp_enqueue_scripts', array( __CLASS__, 'register_assets' ) );
	}

	public static function register_assets(): void {
		// Registered (not enqueued) here — render() enqueues only on pages that
		// actually use the shortcode, keeping the bundle off content pages.
		wp_register_style(
			'zettapay',
			ZETTAPAY_WP_PLUGIN_URL . 'assets/css/zettapay.css',
			array(),
			ZETTAPAY_WP_VERSION
		);
		wp_register_script(
			'zettapay',
			ZETTAPAY_WP_PLUGIN_URL . 'assets/js/zettapay.js',
			array(),
			ZETTAPAY_WP_VERSION,
			true
		);
	}

	/**
	 * Public test seam — also used as the shortcode handler. Pure: takes the
	 * raw attribute array + a settings snapshot, returns sanitized HTML. No
	 * `do_shortcode` recursion, no global state writes.
	 */
	public static function render( $atts, $content = null, $tag = self::TAG ): string {
		$settings = ZettaPay_Settings::get();
		return self::render_with_settings( $atts, $settings );
	}

	public static function render_with_settings( $atts, array $settings ): string {
		$atts = is_array( $atts ) ? $atts : array();

		$defaults = array(
			'merchant'    => $settings['merchant_id'] ?? '',
			'amount'      => '',
			'currency'    => $settings['currency'] ?? 'USDC',
			'label'       => $settings['button_label'] ?? __( 'Pagar com USDC', 'zettapay' ),
			'order_ref'   => '',
			'success_url' => '',
			'cancel_url'  => '',
			'modal'       => ! empty( $settings['open_in_modal'] ) ? 'true' : 'false',
		);

		$atts = shortcode_atts( $defaults, $atts, self::TAG );

		$merchant_id = ZettaPay_Settings::sanitize_merchant_id( (string) $atts['merchant'] );
		if ( '' === $merchant_id ) {
			return self::render_misconfigured_notice();
		}

		$amount      = self::sanitize_amount( (string) $atts['amount'] );
		$currency    = ZettaPay_Settings::sanitize_currency( (string) $atts['currency'] ) ?: 'USDC';
		$label       = self::sanitize_label( (string) $atts['label'] );
		$order_ref   = self::sanitize_token( (string) $atts['order_ref'] );
		$success_url = self::sanitize_url( (string) $atts['success_url'] );
		$cancel_url  = self::sanitize_url( (string) $atts['cancel_url'] );
		$open_modal  = self::is_truthy( $atts['modal'] );

		$pay_base = ZettaPay_Settings::sanitize_pay_base( $settings['pay_base'] ?? '' );
		if ( '' === $pay_base ) {
			$pay_base = ZettaPay_Settings::PAY_BASE_DEFAULT;
		}

		$checkout_url = self::build_checkout_url(
			$pay_base,
			array(
				'merchant'    => $merchant_id,
				'amount'      => $amount,
				'currency'    => $currency,
				'order_ref'   => $order_ref,
				'success_url' => $success_url,
				'cancel_url'  => $cancel_url,
			)
		);

		// Only enqueue the runtime when WP is actually rendering a page (avoids
		// leaking <script> tags into REST responses or feeds).
		if ( function_exists( 'wp_enqueue_style' ) ) {
			wp_enqueue_style( 'zettapay' );
		}
		if ( $open_modal && function_exists( 'wp_enqueue_script' ) ) {
			wp_enqueue_script( 'zettapay' );
		}

		$amount_label = '' !== $amount ? sprintf( '%s %s', $amount, $currency ) : '';
		$aria_label   = trim( $label . ( '' !== $amount_label ? ' ' . $amount_label : '' ) );

		$html  = '<a class="zettapay-btn" ';
		$html .= 'href="' . esc_url( $checkout_url ) . '" ';
		$html .= 'target="_blank" rel="noopener noreferrer" ';
		$html .= 'data-zettapay-merchant="' . esc_attr( $merchant_id ) . '" ';
		if ( '' !== $amount ) {
			$html .= 'data-zettapay-amount="' . esc_attr( $amount ) . '" ';
		}
		$html .= 'data-zettapay-currency="' . esc_attr( $currency ) . '" ';
		if ( $open_modal ) {
			$html .= 'data-zettapay-modal="true" ';
		}
		$html .= 'aria-label="' . esc_attr( $aria_label ) . '">';
		$html .= '<span class="zettapay-btn__brand">ZettaPay</span>';
		$html .= '<span class="zettapay-btn__label">' . esc_html( $label ) . '</span>';
		if ( '' !== $amount_label ) {
			$html .= '<span class="zettapay-btn__amount">' . esc_html( $amount_label ) . '</span>';
		}
		$html .= '</a>';

		return $html;
	}

	public static function build_checkout_url( string $pay_base, array $params ): string {
		$pay_base = rtrim( $pay_base, '/' );
		$query    = array( 'merchant' => $params['merchant'] );
		foreach ( array( 'amount', 'currency', 'order_ref', 'success_url', 'cancel_url' ) as $key ) {
			if ( isset( $params[ $key ] ) && '' !== $params[ $key ] ) {
				$query[ $key ] = $params[ $key ];
			}
		}
		$query['source'] = 'wordpress';
		return $pay_base . '/pay/checkout?' . http_build_query( $query );
	}

	public static function sanitize_amount( string $raw ): string {
		$value = trim( $raw );
		if ( '' === $value ) {
			return '';
		}
		$value = str_replace( ',', '.', $value );
		if ( ! preg_match( '/^\d+(?:\.\d{1,8})?$/', $value ) ) {
			return '';
		}
		return $value;
	}

	public static function sanitize_label( string $raw ): string {
		$value = trim( wp_strip_all_tags( $raw ) );
		if ( '' === $value ) {
			$value = __( 'Pagar com USDC', 'zettapay' );
		}
		return mb_substr( $value, 0, 80 );
	}

	public static function sanitize_token( string $raw ): string {
		$value = trim( $raw );
		if ( '' === $value ) {
			return '';
		}
		if ( ! preg_match( '/^[A-Za-z0-9._:-]{1,64}$/', $value ) ) {
			return '';
		}
		return $value;
	}

	public static function sanitize_url( string $raw ): string {
		$value = trim( $raw );
		if ( '' === $value ) {
			return '';
		}
		// Premissa central #15: webhook destinations must be TLS. We treat
		// success/cancel URLs the same way to avoid mixed-content drop-offs.
		if ( ! preg_match( '#^https://#i', $value ) ) {
			return '';
		}
		return esc_url_raw( $value );
	}

	private static function is_truthy( $value ): bool {
		if ( is_bool( $value ) ) {
			return $value;
		}
		$str = is_scalar( $value ) ? strtolower( trim( (string) $value ) ) : '';
		return in_array( $str, array( '1', 'true', 'yes', 'on' ), true );
	}

	private static function render_misconfigured_notice(): string {
		if ( ! current_user_can( 'manage_options' ) ) {
			return '';
		}
		return '<span class="zettapay-btn zettapay-btn--error" role="status">'
			. esc_html__( 'ZettaPay: configure um Merchant ID em Configurações → ZettaPay.', 'zettapay' )
			. '</span>';
	}
}
