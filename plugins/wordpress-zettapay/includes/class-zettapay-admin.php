<?php
/**
 * Admin settings page (Settings → ZettaPay).
 *
 * @package ZettaPay\WordPress
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

class ZettaPay_Admin {

	const PAGE_SLUG  = 'zettapay';
	const GROUP_SLUG = 'zettapay_settings';

	public static function register(): void {
		add_action( 'admin_init', array( __CLASS__, 'register_settings' ) );
		add_action( 'admin_menu', array( __CLASS__, 'register_menu' ) );
		add_filter(
			'plugin_action_links_' . plugin_basename( ZETTAPAY_WP_PLUGIN_FILE ),
			array( __CLASS__, 'plugin_action_links' )
		);
	}

	public static function register_settings(): void {
		register_setting(
			self::GROUP_SLUG,
			ZETTAPAY_WP_OPTIONS_KEY,
			array(
				'type'              => 'array',
				'sanitize_callback' => array( 'ZettaPay_Settings', 'sanitize' ),
				'default'           => ZettaPay_Settings::defaults(),
			)
		);

		add_settings_section(
			'zettapay_credentials',
			__( 'Credenciais ZettaPay', 'zettapay' ),
			array( __CLASS__, 'render_credentials_intro' ),
			self::PAGE_SLUG
		);

		add_settings_field(
			'merchant_id',
			__( 'Merchant ID', 'zettapay' ),
			array( __CLASS__, 'render_merchant_id_field' ),
			self::PAGE_SLUG,
			'zettapay_credentials'
		);

		add_settings_field(
			'pay_base',
			__( 'API base URL', 'zettapay' ),
			array( __CLASS__, 'render_pay_base_field' ),
			self::PAGE_SLUG,
			'zettapay_credentials'
		);

		add_settings_section(
			'zettapay_button',
			__( 'Aparência do botão', 'zettapay' ),
			'__return_false',
			self::PAGE_SLUG
		);

		add_settings_field(
			'button_label',
			__( 'Texto do botão (default)', 'zettapay' ),
			array( __CLASS__, 'render_button_label_field' ),
			self::PAGE_SLUG,
			'zettapay_button'
		);

		add_settings_field(
			'currency',
			__( 'Moeda (default)', 'zettapay' ),
			array( __CLASS__, 'render_currency_field' ),
			self::PAGE_SLUG,
			'zettapay_button'
		);

		add_settings_field(
			'open_in_modal',
			__( 'Abrir checkout em modal', 'zettapay' ),
			array( __CLASS__, 'render_modal_field' ),
			self::PAGE_SLUG,
			'zettapay_button'
		);
	}

	public static function register_menu(): void {
		add_options_page(
			__( 'ZettaPay', 'zettapay' ),
			__( 'ZettaPay', 'zettapay' ),
			'manage_options',
			self::PAGE_SLUG,
			array( __CLASS__, 'render_page' )
		);
	}

	public static function plugin_action_links( $links ) {
		if ( ! is_array( $links ) ) {
			return $links;
		}
		$url      = admin_url( 'options-general.php?page=' . self::PAGE_SLUG );
		$settings = '<a href="' . esc_url( $url ) . '">' . esc_html__( 'Configurações', 'zettapay' ) . '</a>';
		array_unshift( $links, $settings );
		return $links;
	}

	public static function render_page(): void {
		if ( ! current_user_can( 'manage_options' ) ) {
			return;
		}
		?>
		<div class="wrap zettapay-admin">
			<h1><?php echo esc_html__( 'ZettaPay', 'zettapay' ); ?></h1>
			<p class="description">
				<?php
				echo esc_html__(
					'Aceite USDC liquidados em segundos via Solana em qualquer página WordPress. Use o shortcode abaixo onde quiser exibir um botão de checkout.',
					'zettapay'
				);
				?>
			</p>

			<form method="post" action="options.php">
				<?php
				settings_fields( self::GROUP_SLUG );
				do_settings_sections( self::PAGE_SLUG );
				submit_button();
				?>
			</form>

			<h2><?php echo esc_html__( 'Como usar o shortcode', 'zettapay' ); ?></h2>
			<p><?php echo esc_html__( 'Cole o shortcode em qualquer página, post ou widget de texto:', 'zettapay' ); ?></p>
			<pre class="zettapay-snippet"><code>[zettapay merchant="<?php echo esc_html( ZettaPay_Settings::get()['merchant_id'] ?: 'merch_xxx' ); ?>" amount="10.00"]</code></pre>
			<p>
				<strong><?php echo esc_html__( 'Atributos suportados:', 'zettapay' ); ?></strong>
			</p>
			<ul style="list-style:disc;margin-left:20px;">
				<li><code>merchant</code> — <?php echo esc_html__( 'Merchant ID (obrigatório, ou usa o default desta página).', 'zettapay' ); ?></li>
				<li><code>amount</code> — <?php echo esc_html__( 'Valor decimal opcional (ex.: 10.00).', 'zettapay' ); ?></li>
				<li><code>currency</code> — <?php echo esc_html__( 'Moeda (default USDC).', 'zettapay' ); ?></li>
				<li><code>label</code> — <?php echo esc_html__( 'Texto exibido no botão.', 'zettapay' ); ?></li>
				<li><code>order_ref</code> — <?php echo esc_html__( 'Identificador interno do pedido (opcional).', 'zettapay' ); ?></li>
				<li><code>success_url</code>, <code>cancel_url</code> — <?php echo esc_html__( 'URLs HTTPS de retorno (opcional).', 'zettapay' ); ?></li>
				<li><code>modal</code> — <?php echo esc_html__( '"true" abre o checkout em iframe modal; "false" abre em nova aba.', 'zettapay' ); ?></li>
			</ul>
		</div>
		<?php
	}

	public static function render_credentials_intro(): void {
		echo '<p>' . esc_html__(
			'Cole o Merchant ID gerado no dashboard ZettaPay. Não armazenamos chaves privadas — todos os pagamentos são transferências diretas payer → merchant.',
			'zettapay'
		) . '</p>';
	}

	public static function render_merchant_id_field(): void {
		$settings = ZettaPay_Settings::get();
		$value    = $settings['merchant_id'];
		printf(
			'<input type="text" name="%s[merchant_id]" value="%s" class="regular-text" placeholder="merch_xxx" autocomplete="off" />',
			esc_attr( ZETTAPAY_WP_OPTIONS_KEY ),
			esc_attr( $value )
		);
		echo '<p class="description">' . esc_html__( 'Aceita o formato "merch_xxx" ou "@handle". Pode ser sobrescrito por shortcode.', 'zettapay' ) . '</p>';
	}

	public static function render_pay_base_field(): void {
		$settings = ZettaPay_Settings::get();
		$value    = $settings['pay_base'];
		printf(
			'<input type="url" name="%s[pay_base]" value="%s" class="regular-text" inputmode="url" />',
			esc_attr( ZETTAPAY_WP_OPTIONS_KEY ),
			esc_attr( $value )
		);
		echo '<p class="description">' . esc_html__( 'Default: https://api.zettapay.io. Use uma URL https:// alternativa apenas para sandbox.', 'zettapay' ) . '</p>';
	}

	public static function render_button_label_field(): void {
		$settings = ZettaPay_Settings::get();
		printf(
			'<input type="text" name="%s[button_label]" value="%s" class="regular-text" maxlength="80" />',
			esc_attr( ZETTAPAY_WP_OPTIONS_KEY ),
			esc_attr( $settings['button_label'] )
		);
	}

	public static function render_currency_field(): void {
		$settings = ZettaPay_Settings::get();
		printf(
			'<input type="text" name="%s[currency]" value="%s" class="small-text" maxlength="8" />',
			esc_attr( ZETTAPAY_WP_OPTIONS_KEY ),
			esc_attr( $settings['currency'] )
		);
		echo '<p class="description">' . esc_html__( 'V1 só suporta USDC.', 'zettapay' ) . '</p>';
	}

	public static function render_modal_field(): void {
		$settings = ZettaPay_Settings::get();
		$checked  = ! empty( $settings['open_in_modal'] ) ? 'checked' : '';
		printf(
			'<label><input type="checkbox" name="%s[open_in_modal]" value="1" %s /> %s</label>',
			esc_attr( ZETTAPAY_WP_OPTIONS_KEY ),
			esc_attr( $checked ),
			esc_html__( 'Quando marcado, o botão abre o checkout em um iframe modal sem sair da página.', 'zettapay' )
		);
	}
}
