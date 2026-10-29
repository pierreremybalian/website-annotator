<?php
/**
 * Option helpers and sanitizers shared by the admin, REST and frontend code.
 *
 * @package Annotate
 */

defined( 'ABSPATH' ) || exit;

/**
 * Default values for the annotate_settings option.
 *
 * An empty endpoint means "use ANNOTATE_DEFAULT_ENDPOINT".
 *
 * @return array<string, mixed>
 */
function annotate_default_settings(): array {
	return array(
		'endpoint'     => '',
		'project_key'  => '',
		'access_key'   => '',
		'board_name'   => '',
		'board_url'    => '',
		'capability'   => 'edit_posts',
		'access_links' => true,
		'position'     => 'bottom-right',
	);
}

/**
 * The stored settings merged over the defaults.
 *
 * @return array<string, mixed>
 */
function annotate_get_settings(): array {
	$stored = get_option( ANNOTATE_OPTION, array() );
	if ( ! is_array( $stored ) ) {
		$stored = array();
	}
	return array_merge( annotate_default_settings(), array_intersect_key( $stored, annotate_default_settings() ) );
}

/**
 * Whether a project is connected (both keys present).
 */
function annotate_is_connected(): bool {
	$settings = annotate_get_settings();
	return '' !== $settings['project_key'] && '' !== $settings['access_key'];
}

/**
 * The Worker base URL in use, without a trailing slash.
 */
function annotate_endpoint(): string {
	$settings = annotate_get_settings();
	$endpoint = '' !== $settings['endpoint'] ? $settings['endpoint'] : annotate_sanitize_endpoint( ANNOTATE_DEFAULT_ENDPOINT );
	return untrailingslashit( $endpoint );
}

/**
 * Who may see the widget: capability => label.
 *
 * @return array<string, string>
 */
function annotate_capability_choices(): array {
	return array(
		'manage_options'    => __( 'Administrators', 'annotate' ),
		'edit_others_posts' => __( 'Editors and above', 'annotate' ),
		'edit_posts'        => __( 'Contributors, Authors and above', 'annotate' ),
		'read'              => __( 'Any logged-in user', 'annotate' ),
	);
}

/**
 * Widget positions: value => label.
 *
 * @return array<string, string>
 */
function annotate_position_choices(): array {
	return array(
		'bottom-right' => __( 'Bottom right', 'annotate' ),
		'bottom-left'  => __( 'Bottom left', 'annotate' ),
	);
}

/**
 * Drop the cached /v1/project status.
 */
function annotate_flush_status(): void {
	delete_transient( ANNOTATE_STATUS_TRANSIENT );
}

/**
 * The origin (scheme://host[:port]) of a URL, lowercased, default ports dropped. Empty if invalid.
 *
 * Matches what the browser reports as event.origin / URL.origin.
 *
 * @param string $url URL.
 */
function annotate_url_origin( string $url ): string {
	$parts = wp_parse_url( $url );
	if ( ! is_array( $parts ) || empty( $parts['scheme'] ) || empty( $parts['host'] ) ) {
		return '';
	}
	$scheme = strtolower( $parts['scheme'] );
	$origin = $scheme . '://' . strtolower( $parts['host'] );
	if ( isset( $parts['port'] ) ) {
		$port         = (int) $parts['port'];
		$default_port = ( 'http' === $scheme && 80 === $port ) || ( 'https' === $scheme && 443 === $port );
		if ( ! $default_port ) {
			$origin .= ':' . $port;
		}
	}
	return $origin;
}

/**
 * Normalize a Worker endpoint to scheme://host[:port][/path] with no trailing slash, query or fragment.
 *
 * @param mixed $value Raw value.
 * @return string Normalized URL, or '' when empty/invalid.
 */
function annotate_sanitize_endpoint( $value ): string {
	if ( ! is_string( $value ) ) {
		return '';
	}
	$value = trim( $value );
	if ( '' === $value ) {
		return '';
	}
	$url = esc_url_raw( $value, array( 'http', 'https' ) );
	if ( '' === $url ) {
		return '';
	}
	$origin = annotate_url_origin( $url );
	if ( '' === $origin ) {
		return '';
	}
	$path = (string) wp_parse_url( $url, PHP_URL_PATH );
	return $origin . untrailingslashit( $path );
}

/**
 * Project and access keys: URL-safe characters only (they end up in headers, data-* attributes and links).
 *
 * @param mixed $value Raw value.
 * @return string The key, or '' when invalid.
 */
function annotate_sanitize_key( $value ): string {
	if ( ! is_string( $value ) ) {
		return '';
	}
	$value = trim( $value );
	return preg_match( '/^[A-Za-z0-9._~-]{1,200}$/', $value ) ? $value : '';
}

/**
 * Sanitize callback for the annotate_settings option.
 *
 * Merges the submitted keys over the current settings, so the settings form (which only posts
 * capability, access_links, position and endpoint) never wipes the connection keys. Idempotent:
 * safe to run more than once on the same value.
 *
 * @param mixed $input Submitted settings.
 * @return array<string, mixed>
 */
function annotate_sanitize_settings( $input ): array {
	$current = annotate_get_settings();
	if ( ! is_array( $input ) ) {
		return $current;
	}

	$out = $current;

	if ( array_key_exists( 'endpoint', $input ) ) {
		$raw      = is_string( $input['endpoint'] ) ? trim( $input['endpoint'] ) : '';
		$endpoint = annotate_sanitize_endpoint( $raw );
		if ( '' === $raw || $endpoint === annotate_sanitize_endpoint( ANNOTATE_DEFAULT_ENDPOINT ) ) {
			$out['endpoint'] = '';
		} elseif ( '' !== $endpoint ) {
			$out['endpoint'] = $endpoint;
		} elseif ( function_exists( 'add_settings_error' ) ) {
			add_settings_error( ANNOTATE_OPTION, 'annotate_endpoint', __( 'The endpoint URL is not valid, so the previous one was kept.', 'annotate' ) );
		}
	}

	foreach ( array( 'project_key', 'access_key' ) as $key ) {
		if ( array_key_exists( $key, $input ) ) {
			$out[ $key ] = annotate_sanitize_key( $input[ $key ] );
		}
	}

	if ( array_key_exists( 'board_name', $input ) ) {
		$out['board_name'] = is_string( $input['board_name'] ) ? mb_substr( sanitize_text_field( $input['board_name'] ), 0, 200 ) : '';
	}

	if ( array_key_exists( 'board_url', $input ) ) {
		$out['board_url'] = is_string( $input['board_url'] ) ? esc_url_raw( trim( $input['board_url'] ), array( 'http', 'https' ) ) : '';
	}

	if ( array_key_exists( 'capability', $input ) ) {
		$out['capability'] = is_string( $input['capability'] ) && array_key_exists( $input['capability'], annotate_capability_choices() )
			? $input['capability']
			: 'edit_posts';
	}

	if ( array_key_exists( 'access_links', $input ) ) {
		$out['access_links'] = rest_sanitize_boolean( $input['access_links'] );
	}

	if ( array_key_exists( 'position', $input ) ) {
		$out['position'] = is_string( $input['position'] ) && array_key_exists( $input['position'], annotate_position_choices() )
			? $input['position']
			: 'bottom-right';
	}

	return $out;
}
