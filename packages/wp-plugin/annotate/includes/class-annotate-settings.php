<?php
/**
 * Settings → Annotate: connect/disconnect Trello, connection status, widget options.
 *
 * @package Annotate
 */

defined( 'ABSPATH' ) || exit;

/**
 * Admin settings page.
 */
class Annotate_Settings {

	const PAGE_SLUG = 'annotate';

	/**
	 * Hook suffix returned by add_options_page().
	 *
	 * @var string
	 */
	private string $hook_suffix = '';

	/**
	 * Register hooks.
	 */
	public function register(): void {
		// On init (not admin_init) so the sanitize callback also applies to REST updates.
		add_action( 'init', array( $this, 'register_setting' ) );
		add_action( 'admin_menu', array( $this, 'add_page' ) );
		add_action( 'admin_enqueue_scripts', array( $this, 'enqueue_assets' ) );
		// Fires on every save, even when nothing changed, so "Save" always refreshes the status.
		add_filter( 'pre_update_option_' . ANNOTATE_OPTION, array( $this, 'flush_status_on_save' ) );
		add_filter( 'plugin_action_links_' . plugin_basename( ANNOTATE_FILE ), array( $this, 'action_links' ) );
	}

	/**
	 * Register the single annotate_settings option.
	 */
	public function register_setting(): void {
		register_setting(
			'annotate',
			ANNOTATE_OPTION,
			array(
				'type'              => 'array',
				'sanitize_callback' => 'annotate_sanitize_settings',
				'default'           => annotate_default_settings(),
				'show_in_rest'      => false,
			)
		);
	}

	/**
	 * Bust the status cache whenever the option is saved.
	 *
	 * @param mixed $value New option value.
	 * @return mixed
	 */
	public function flush_status_on_save( $value ) {
		annotate_flush_status();
		return $value;
	}

	/**
	 * Add Settings → Annotate.
	 */
	public function add_page(): void {
		$hook = add_options_page(
			__( 'Annotate', 'annotate' ),
			__( 'Annotate', 'annotate' ),
			'manage_options',
			self::PAGE_SLUG,
			array( $this, 'render_page' )
		);
		$this->hook_suffix = is_string( $hook ) ? $hook : '';
	}

	/**
	 * "Settings" link on the Plugins screen.
	 *
	 * @param string[] $links Action links.
	 * @return string[]
	 */
	public function action_links( $links ): array {
		$links = is_array( $links ) ? $links : array();
		array_unshift(
			$links,
			sprintf(
				'<a href="%s">%s</a>',
				esc_url( self::page_url() ),
				esc_html__( 'Settings', 'annotate' )
			)
		);
		return $links;
	}

	/**
	 * URL of the settings page.
	 */
	public static function page_url(): string {
		return admin_url( 'options-general.php?page=' . self::PAGE_SLUG );
	}

	/**
	 * Load admin.js / admin.css on our page only.
	 *
	 * @param string $hook_suffix Current admin page.
	 */
	public function enqueue_assets( $hook_suffix ): void {
		if ( '' === $this->hook_suffix || $hook_suffix !== $this->hook_suffix ) {
			return;
		}

		$url      = plugin_dir_url( ANNOTATE_FILE );
		$settings = annotate_get_settings();

		wp_enqueue_style( 'annotate-admin', $url . 'assets/admin.css', array(), ANNOTATE_VERSION );
		wp_enqueue_script( 'annotate-admin', $url . 'assets/admin.js', array(), ANNOTATE_VERSION, true );

		$config = array(
			'endpoint'   => annotate_endpoint(),
			'siteName'   => wp_specialchars_decode( get_bloginfo( 'name' ), ENT_QUOTES ),
			'homeUrl'    => home_url( '/' ),
			'projectKey' => $settings['project_key'],
			'accessKey'  => $settings['access_key'],
			'restUrl'    => rest_url( 'annotate/v1/connection' ),
			'nonce'      => wp_create_nonce( 'wp_rest' ),
			'pageUrl'    => self::page_url(),
			'i18n'       => array(
				'confirmDisconnect' => __( 'Disconnect Trello? The widget will stop working on this site until you connect again. Existing Trello cards are not affected.', 'annotate' ),
				'waiting'           => __( 'Finish connecting in the popup window…', 'annotate' ),
				'saving'            => __( 'Saving the connection…', 'annotate' ),
				'disconnecting'     => __( 'Disconnecting…', 'annotate' ),
				'saveFailed'        => __( 'Could not save the connection:', 'annotate' ),
				'disconnectFailed'  => __( 'Could not disconnect:', 'annotate' ),
				'copied'            => __( 'Copied', 'annotate' ),
				'copy'              => __( 'Copy', 'annotate' ),
			),
		);

		wp_add_inline_script( 'annotate-admin', 'window.annotateAdmin = ' . wp_json_encode( $config, JSON_HEX_TAG | JSON_HEX_AMP ) . ';', 'before' );
	}

	/**
	 * Connection status from GET {endpoint}/v1/project, cached for 5 minutes.
	 *
	 * @return array{state: string, message: string, name: string, board_name: string, board_url: string, issue_count: int}
	 */
	public static function get_status(): array {
		$cached = get_transient( ANNOTATE_STATUS_TRANSIENT );
		if ( is_array( $cached ) && isset( $cached['state'] ) ) {
			return $cached;
		}

		$settings = annotate_get_settings();
		$status   = array(
			'state'       => 'error',
			'message'     => '',
			'name'        => '',
			'board_name'  => '',
			'board_url'   => '',
			'issue_count' => 0,
		);
		$ttl      = 5 * MINUTE_IN_SECONDS;

		$response = wp_remote_get(
			annotate_endpoint() . '/v1/project',
			array(
				'timeout' => 8,
				'headers' => array(
					'Accept'             => 'application/json',
					'X-Annotate-Project' => $settings['project_key'],
					'X-Annotate-Access'  => $settings['access_key'],
				),
			)
		);

		if ( is_wp_error( $response ) ) {
			$status['message'] = $response->get_error_message();
			$ttl               = MINUTE_IN_SECONDS;
		} else {
			$code = (int) wp_remote_retrieve_response_code( $response );
			$body = json_decode( (string) wp_remote_retrieve_body( $response ), true );
			$body = is_array( $body ) ? $body : array();

			$revoked = ( isset( $body['reason'] ) && 'token_revoked' === $body['reason'] )
				|| ( isset( $body['code'] ) && 'token_revoked' === $body['code'] );

			if ( 401 === $code || 404 === $code || $revoked ) {
				$status['state'] = 'reconnect';
			} elseif ( $code >= 200 && $code < 300 && isset( $body['connected'] ) ) {
				$status['state']       = ! empty( $body['connected'] ) ? 'ok' : 'reconnect';
				$status['name']        = isset( $body['name'] ) && is_string( $body['name'] ) ? sanitize_text_field( $body['name'] ) : '';
				$status['board_name']  = isset( $body['boardName'] ) && is_string( $body['boardName'] ) ? sanitize_text_field( $body['boardName'] ) : '';
				$status['board_url']   = isset( $body['boardUrl'] ) && is_string( $body['boardUrl'] ) ? esc_url_raw( $body['boardUrl'], array( 'http', 'https' ) ) : '';
				$status['issue_count'] = isset( $body['issueCount'] ) ? max( 0, (int) $body['issueCount'] ) : 0;
			} else {
				$status['message'] = isset( $body['error'] ) && is_string( $body['error'] )
					? sanitize_text_field( $body['error'] )
					/* translators: %d: HTTP status code. */
					: sprintf( __( 'Unexpected response (HTTP %d).', 'annotate' ), $code );
				$ttl               = MINUTE_IN_SECONDS;
			}
		}

		set_transient( ANNOTATE_STATUS_TRANSIENT, $status, $ttl );
		return $status;
	}

	/**
	 * Render Settings → Annotate.
	 */
	public function render_page(): void {
		if ( ! current_user_can( 'manage_options' ) ) {
			return;
		}

		$settings  = annotate_get_settings();
		$connected = annotate_is_connected();
		$status    = $connected ? self::get_status() : null;
		?>
		<div class="wrap annotate-wrap">
			<h1><?php esc_html_e( 'Annotate', 'annotate' ); ?></h1>

			<div class="annotate-card annotate-connection">
				<?php
				if ( $connected ) {
					$this->render_connected( $settings, $status );
				} else {
					$this->render_disconnected();
				}
				?>
				<p class="annotate-message" data-annotate-message role="status" aria-live="polite"></p>
				<p class="annotate-popup-blocked" data-annotate-blocked hidden>
					<?php esc_html_e( 'Your browser blocked the popup.', 'annotate' ); ?>
					<a href="#" target="_blank" rel="opener" data-annotate-fallback><?php esc_html_e( 'Open the Trello connect page', 'annotate' ); ?></a>
				</p>
			</div>

			<form action="options.php" method="post" class="annotate-settings">
				<?php settings_fields( 'annotate' ); ?>

				<h2><?php esc_html_e( 'Settings', 'annotate' ); ?></h2>
				<table class="form-table" role="presentation">
					<tr>
						<th scope="row"><label for="annotate-capability"><?php esc_html_e( 'Who sees the widget', 'annotate' ); ?></label></th>
						<td>
							<select id="annotate-capability" name="<?php echo esc_attr( ANNOTATE_OPTION ); ?>[capability]">
								<?php foreach ( annotate_capability_choices() as $cap => $label ) : ?>
									<option value="<?php echo esc_attr( $cap ); ?>" <?php selected( $settings['capability'], $cap ); ?>><?php echo esc_html( $label ); ?></option>
								<?php endforeach; ?>
							</select>
							<p class="description"><?php esc_html_e( 'Logged-in users with this role see the feedback button on every page, with their name and email filled in.', 'annotate' ); ?></p>
						</td>
					</tr>
					<tr>
						<th scope="row"><?php esc_html_e( 'Access links', 'annotate' ); ?></th>
						<td>
							<input type="hidden" name="<?php echo esc_attr( ANNOTATE_OPTION ); ?>[access_links]" value="0">
							<label for="annotate-access-links">
								<input type="checkbox" id="annotate-access-links" name="<?php echo esc_attr( ANNOTATE_OPTION ); ?>[access_links]" value="1" <?php checked( (bool) $settings['access_links'] ); ?>>
								<?php esc_html_e( 'Let people who are not logged in turn on feedback mode with a private link', 'annotate' ); ?>
							</label>
							<p class="description"><?php esc_html_e( 'Regular visitors never download the widget.', 'annotate' ); ?></p>

							<?php if ( $connected ) : ?>
								<div class="annotate-access-link" data-annotate-access-link <?php echo $settings['access_links'] ? '' : 'hidden'; ?>>
									<label for="annotate-activation-link" class="screen-reader-text"><?php esc_html_e( 'Activation link', 'annotate' ); ?></label>
									<div class="annotate-link-field">
										<input type="text" id="annotate-activation-link" class="regular-text code" readonly value="<?php echo esc_url( home_url( '/?annotate=' . rawurlencode( $settings['access_key'] ) ) ); ?>">
										<button type="button" class="button" data-annotate-copy="annotate-activation-link"><?php esc_html_e( 'Copy', 'annotate' ); ?></button>
									</div>
									<p class="description"><?php esc_html_e( 'Send this to clients; opening it once turns on feedback mode in their browser.', 'annotate' ); ?></p>
								</div>
							<?php endif; ?>
						</td>
					</tr>
					<tr>
						<th scope="row"><label for="annotate-position"><?php esc_html_e( 'Button position', 'annotate' ); ?></label></th>
						<td>
							<select id="annotate-position" name="<?php echo esc_attr( ANNOTATE_OPTION ); ?>[position]">
								<?php foreach ( annotate_position_choices() as $value => $label ) : ?>
									<option value="<?php echo esc_attr( $value ); ?>" <?php selected( $settings['position'], $value ); ?>><?php echo esc_html( $label ); ?></option>
								<?php endforeach; ?>
							</select>
						</td>
					</tr>
				</table>

				<details class="annotate-advanced">
					<summary><?php esc_html_e( 'Advanced', 'annotate' ); ?></summary>
					<table class="form-table" role="presentation">
						<tr>
							<th scope="row"><label for="annotate-endpoint"><?php esc_html_e( 'Endpoint URL', 'annotate' ); ?></label></th>
							<td>
								<input type="url" id="annotate-endpoint" class="regular-text code" name="<?php echo esc_attr( ANNOTATE_OPTION ); ?>[endpoint]" value="<?php echo esc_attr( $settings['endpoint'] ); ?>" placeholder="<?php echo esc_attr( annotate_sanitize_endpoint( ANNOTATE_DEFAULT_ENDPOINT ) ); ?>">
								<p class="description">
									<?php
									printf(
										/* translators: 1: default endpoint URL, 2: local development URL. */
										esc_html__( 'The Annotate server. Leave empty to use %1$s. For local development use %2$s. Changing it requires connecting again.', 'annotate' ),
										'<code>' . esc_html( annotate_sanitize_endpoint( ANNOTATE_DEFAULT_ENDPOINT ) ) . '</code>',
										'<code>http://localhost:8787</code>'
									);
									?>
								</p>
							</td>
						</tr>
					</table>
				</details>

				<?php submit_button(); ?>
			</form>
		</div>
		<?php
	}

	/**
	 * Not connected: one line and a big button.
	 */
	private function render_disconnected(): void {
		?>
		<h2><?php esc_html_e( 'Connect Trello', 'annotate' ); ?></h2>
		<p><?php esc_html_e( 'Log in to Trello in a popup and pick a board. Every issue reported on this site becomes a card there.', 'annotate' ); ?></p>
		<p class="annotate-actions">
			<button type="button" class="button button-primary button-hero" data-annotate-action="connect"><?php esc_html_e( 'Connect Trello', 'annotate' ); ?></button>
		</p>
		<?php
	}

	/**
	 * Connected: board link, issue count, Reconnect / Disconnect.
	 *
	 * @param array<string, mixed>      $settings Current settings.
	 * @param array<string, mixed>|null $status   Result of get_status().
	 */
	private function render_connected( array $settings, ?array $status ): void {
		$state      = $status['state'] ?? 'error';
		$board_name = ! empty( $status['board_name'] ) ? $status['board_name'] : $settings['board_name'];
		$board_url  = ! empty( $status['board_url'] ) ? $status['board_url'] : $settings['board_url'];
		if ( '' === $board_name ) {
			$board_name = __( 'your Trello board', 'annotate' );
		}

		$board_link = '' !== $board_url
			? sprintf( '<a href="%s" target="_blank" rel="noopener noreferrer">%s</a>', esc_url( $board_url ), esc_html( $board_name ) )
			: '<strong>' . esc_html( $board_name ) . '</strong>';
		?>
		<?php if ( 'reconnect' === $state ) : ?>
			<h2><?php esc_html_e( 'Reconnect needed', 'annotate' ); ?></h2>
			<div class="notice notice-warning inline">
				<p>
					<?php
					printf(
						/* translators: %s: Trello board link. */
						esc_html__( 'Annotate can no longer reach %s. The Trello access may have been revoked. Reconnect to keep receiving feedback.', 'annotate' ),
						$board_link // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- escaped above.
					);
					?>
				</p>
			</div>
		<?php else : ?>
			<h2 class="annotate-connected">
				<?php
				printf(
					/* translators: %s: Trello board link. */
					esc_html__( 'Connected to %s', 'annotate' ),
					$board_link // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- escaped above.
				);
				?>
				<span class="annotate-check" aria-hidden="true">✓</span>
			</h2>
			<?php if ( 'ok' === $state ) : ?>
				<p class="annotate-count">
					<?php
					$count = (int) $status['issue_count'];
					echo esc_html(
						sprintf(
							/* translators: %s: number of issues. */
							_n( '%s issue reported so far.', '%s issues reported so far.', $count, 'annotate' ),
							number_format_i18n( $count )
						)
					);
					?>
				</p>
			<?php else : ?>
				<div class="notice notice-warning inline">
					<p>
						<?php esc_html_e( 'Could not check the connection right now.', 'annotate' ); ?>
						<?php if ( ! empty( $status['message'] ) ) : ?>
							<code><?php echo esc_html( $status['message'] ); ?></code>
						<?php endif; ?>
					</p>
				</div>
			<?php endif; ?>
		<?php endif; ?>

		<p class="annotate-actions">
			<button type="button" class="button <?php echo 'reconnect' === $state ? 'button-primary' : ''; ?>" data-annotate-action="reconnect"><?php esc_html_e( 'Reconnect', 'annotate' ); ?></button>
			<button type="button" class="button annotate-disconnect" data-annotate-action="disconnect"><?php esc_html_e( 'Disconnect', 'annotate' ); ?></button>
		</p>
		<?php
	}
}
