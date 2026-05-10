<?php
/**
 * Plugin Name: ZettaPay
 * Plugin URI: https://zettapay.io/wordpress
 * Description: Aceite USDC liquidados em segundos via Solana em qualquer página WordPress. Use o shortcode [zettapay merchant="merch_xxx"] para inserir um botão de checkout. Funciona com ou sem WooCommerce.
 * Version: 0.1.0
 * Requires at least: 6.0
 * Requires PHP: 7.4
 * Author: ZettaPay
 * Author URI: https://zettapay.io
 * License: MIT
 * Text Domain: zettapay
 * Domain Path: /languages
 *
 * @package ZettaPay\WordPress
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

define( 'ZETTAPAY_WP_VERSION', '0.1.0' );
define( 'ZETTAPAY_WP_PLUGIN_FILE', __FILE__ );
define( 'ZETTAPAY_WP_PLUGIN_DIR', plugin_dir_path( __FILE__ ) );
define( 'ZETTAPAY_WP_PLUGIN_URL', plugin_dir_url( __FILE__ ) );
define( 'ZETTAPAY_WP_OPTIONS_KEY', 'zettapay_wp_settings' );

require_once ZETTAPAY_WP_PLUGIN_DIR . 'includes/class-zettapay-settings.php';
require_once ZETTAPAY_WP_PLUGIN_DIR . 'includes/class-zettapay-shortcode.php';
require_once ZETTAPAY_WP_PLUGIN_DIR . 'includes/class-zettapay-admin.php';

add_action( 'plugins_loaded', 'zettapay_wp_bootstrap' );

function zettapay_wp_bootstrap() {
	load_plugin_textdomain(
		'zettapay',
		false,
		dirname( plugin_basename( __FILE__ ) ) . '/languages'
	);

	ZettaPay_Shortcode::register();

	if ( is_admin() ) {
		ZettaPay_Admin::register();
	}
}

register_activation_hook( __FILE__, 'zettapay_wp_on_activate' );
function zettapay_wp_on_activate() {
	$existing = get_option( ZETTAPAY_WP_OPTIONS_KEY );
	if ( false === $existing ) {
		add_option( ZETTAPAY_WP_OPTIONS_KEY, ZettaPay_Settings::defaults() );
	}
}
