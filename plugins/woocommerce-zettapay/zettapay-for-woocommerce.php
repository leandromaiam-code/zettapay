<?php
/**
 * Plugin Name: ZettaPay for WooCommerce
 * Plugin URI: https://zettapay.io/woocommerce
 * Description: Aceite pagamentos USDC liquidados em segundos via Solana. Fees 10x menores que cartão, sem custódia.
 * Version: 0.1.0
 * Requires at least: 6.0
 * Requires PHP: 7.4
 * Author: ZettaPay
 * Author URI: https://zettapay.io
 * License: MIT
 * Text Domain: zettapay-for-woocommerce
 * Domain Path: /languages
 * WC requires at least: 7.0
 * WC tested up to: 9.4
 *
 * @package ZettaPay\WooCommerce
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

define( 'ZETTAPAY_WC_VERSION', '0.1.0' );
define( 'ZETTAPAY_WC_PLUGIN_FILE', __FILE__ );
define( 'ZETTAPAY_WC_PLUGIN_DIR', plugin_dir_path( __FILE__ ) );
define( 'ZETTAPAY_WC_PLUGIN_URL', plugin_dir_url( __FILE__ ) );

/**
 * Bootstrap the gateway once WooCommerce has loaded its payment gateway base
 * classes. Loading earlier would crash sites without WooCommerce installed.
 */
add_action( 'plugins_loaded', 'zettapay_wc_bootstrap', 11 );

function zettapay_wc_bootstrap() {
	if ( ! class_exists( 'WC_Payment_Gateway' ) ) {
		add_action( 'admin_notices', 'zettapay_wc_missing_woocommerce_notice' );
		return;
	}

	require_once ZETTAPAY_WC_PLUGIN_DIR . 'includes/class-zettapay-api-client.php';
	require_once ZETTAPAY_WC_PLUGIN_DIR . 'includes/class-zettapay-webhook-handler.php';
	require_once ZETTAPAY_WC_PLUGIN_DIR . 'includes/class-wc-gateway-zettapay.php';

	add_filter( 'woocommerce_payment_gateways', 'zettapay_wc_register_gateway' );

	ZettaPay_Webhook_Handler::register_routes();

	load_plugin_textdomain(
		'zettapay-for-woocommerce',
		false,
		dirname( plugin_basename( __FILE__ ) ) . '/languages'
	);
}

function zettapay_wc_register_gateway( $gateways ) {
	$gateways[] = 'WC_Gateway_ZettaPay';
	return $gateways;
}

function zettapay_wc_missing_woocommerce_notice() {
	echo '<div class="notice notice-error"><p>';
	echo esc_html__(
		'ZettaPay for WooCommerce requires WooCommerce 7.0+ to be installed and active.',
		'zettapay-for-woocommerce'
	);
	echo '</p></div>';
}

register_activation_hook( __FILE__, 'zettapay_wc_on_activate' );
function zettapay_wc_on_activate() {
	if ( ! get_option( 'zettapay_wc_webhook_secret' ) ) {
		update_option( 'zettapay_wc_webhook_secret', wp_generate_password( 48, false, false ) );
	}
}
