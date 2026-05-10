<?php
/**
 * Removes the single options row created by activation. Loaded directly by
 * WordPress when the user uninstalls the plugin from wp-admin.
 *
 * @package ZettaPay\WordPress
 */

if ( ! defined( 'WP_UNINSTALL_PLUGIN' ) ) {
	exit;
}

delete_option( 'zettapay_wp_settings' );
