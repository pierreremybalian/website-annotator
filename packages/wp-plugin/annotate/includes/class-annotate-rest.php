<?php
/**
 * REST route the settings page uses to save or clear the connection keys from the connect popup.
 *
 * POST   /wp-json/annotate/v1/connection  { projectKey, accessKey, boardName, boardUrl, endpoint? }
 * DELETE /wp-json/annotate/v1/connection
 *
 * Both require manage_options and the wp_rest nonce (X-WP-Nonce), which core's cookie
 * authentication checks before permission_callback runs.
 *
 * @package Annotate
 */

defined( 'ABSPATH' ) || exit;

/**
 * Connection REST controller.
 */
class Annotate_Rest {

	const REST_NAMESPACE = 'annotate/v1';

	/**
	 * Register hooks.
	 */
	public function register(): void {
		add_action( 'rest_api_init', array( $this, 'register_routes' ) );
	}

	/**
	 * Register /annotate/v1/connection.
	 */
	public function register_routes(): void {
		$key_arg = array(
			'type'              => 'string',
			'required'          => true,
			'validate_callback' => static function ( $value ) {
				return '' !== annotate_sanitize_key( $value );
			},
			'sanitize_callback' => static function ( $value ) {
				return annotate_sanitize_key( $value );
			},
		);

		$text_arg = array(
			'type'              => 'string',
			'default'           => '',
			'validate_callback' => static function ( $value ) {
				return is_string( $value );
			},
		);

		register_rest_route(
			self::REST_NAMESPACE,
			'/connection',
			array(
				array(
					'methods'             => WP_REST_Server::CREATABLE,
					'callback'            => array( $this, 'save_connection' ),
					'permission_callback' => array( $this, 'can_manage' ),
					'args'                => array(
						'projectKey' => $key_arg,
						'accessKey'  => $key_arg,
						'boardName'  => $text_arg,
						'boardUrl'   => $text_arg,
						'endpoint'   => $text_arg,
					),
				),
				array(
					'methods'             => WP_REST_Server::DELETABLE,
					'callback'            => array( $this, 'delete_connection' ),
					'permission_callback' => array( $this, 'can_manage' ),
				),
			)
		);
	}

	/**
	 * Only administrators may change the connection.
	 */
	public function can_manage(): bool {
		return current_user_can( 'manage_options' );
	}

	/**
	 * Save the keys the connect popup sent.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return WP_REST_Response
	 */
	public function save_connection( WP_REST_Request $request ): WP_REST_Response {
		$current  = annotate_get_settings();
		$settings = array(
			'project_key' => $request->get_param( 'projectKey' ),
			'access_key'  => $request->get_param( 'accessKey' ),
			'board_name'  => (string) $request->get_param( 'boardName' ),
			'board_url'   => (string) $request->get_param( 'boardUrl' ),
		);

		// The popup reports the Worker URL; accept it only when it is the Worker we are configured for.
		$endpoint = annotate_sanitize_endpoint( (string) $request->get_param( 'endpoint' ) );
		if ( '' !== $endpoint
			&& annotate_url_origin( $endpoint ) === annotate_url_origin( annotate_endpoint() )
			&& $endpoint !== annotate_endpoint()
		) {
			$settings['endpoint'] = $endpoint;
		}

		$settings = annotate_sanitize_settings( array_merge( $current, $settings ) );
		update_option( ANNOTATE_OPTION, $settings );
		annotate_flush_status();

		return new WP_REST_Response(
			array(
				'connected' => annotate_is_connected(),
				'boardName' => $settings['board_name'],
				'boardUrl'  => $settings['board_url'],
			)
		);
	}

	/**
	 * Forget the keys locally. The project stays on the Worker; Trello cards are untouched.
	 *
	 * @return WP_REST_Response
	 */
	public function delete_connection(): WP_REST_Response {
		$settings = array_merge(
			annotate_get_settings(),
			array(
				'project_key' => '',
				'access_key'  => '',
				'board_name'  => '',
				'board_url'   => '',
			)
		);
		update_option( ANNOTATE_OPTION, $settings );
		annotate_flush_status();

		return new WP_REST_Response( array( 'connected' => false ) );
	}
}
