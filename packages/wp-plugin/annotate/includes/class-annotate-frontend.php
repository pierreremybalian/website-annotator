<?php
/**
 * Frontend: early error catcher, widget script tag or access-link loader, admin-bar "Report issue".
 *
 * @package Annotate
 */

defined( 'ABSPATH' ) || exit;

/**
 * Injects the widget on the public site.
 */
class Annotate_Frontend {

	const ADMIN_BAR_NODE = 'annotate-report';

	/**
	 * Register hooks.
	 */
	public function register(): void {
		add_action( 'wp_head', array( $this, 'print_head' ), 1 );
		add_action( 'admin_bar_menu', array( $this, 'add_admin_bar_node' ), 80 );
	}

	/**
	 * Whether this request is a normal, connected frontend page.
	 */
	private function is_eligible_request(): bool {
		if ( is_admin() || wp_doing_ajax() || ( defined( 'REST_REQUEST' ) && REST_REQUEST ) ) {
			return false;
		}
		if ( function_exists( 'is_login' ) ? is_login() : ( isset( $GLOBALS['pagenow'] ) && 'wp-login.php' === $GLOBALS['pagenow'] ) ) {
			return false;
		}
		if ( is_feed() || is_embed() ) {
			return false;
		}
		return annotate_is_connected();
	}

	/**
	 * Whether the current user gets the full widget (with access key and their name/email).
	 *
	 * @param array<string, mixed> $settings Settings.
	 */
	private function user_is_authorized( array $settings ): bool {
		return is_user_logged_in() && current_user_can( $settings['capability'] );
	}

	/**
	 * Output in <head> (priority 1).
	 */
	public function print_head(): void {
		if ( ! $this->is_eligible_request() ) {
			return;
		}

		$settings = annotate_get_settings();

		if ( $this->user_is_authorized( $settings ) ) {
			$this->print_authorized( $settings );
		} elseif ( $settings['access_links'] ) {
			$this->print_loader( $settings );
		}
	}

	/**
	 * Authorized user: catcher, then the widget tag with access key, always-on and reporter prefill.
	 *
	 * @param array<string, mixed> $settings Settings.
	 */
	private function print_authorized( array $settings ): void {
		$endpoint = annotate_endpoint();
		$user     = wp_get_current_user();

		$inline = self::catcher_js();
		if ( is_admin_bar_showing() ) {
			$inline .= "\n" . self::admin_bar_js();
		}
		wp_print_inline_script_tag( $inline, array( 'id' => 'annotate-errors' ) );

		// Pass plain (unescaped) values: wp_get_script_tag() escapes attributes itself (esc_attr before
		// WP 7.0, WP_HTML_Tag_Processor since), so pre-escaped input would be double-encoded on newer cores.
		// The endpoint and keys are already sanitized on save; display_name is stored entity-encoded.
		wp_print_script_tag(
			array(
				'id'                  => 'annotate-widget',
				'src'                 => esc_url_raw( $endpoint . '/widget.js' ),
				'defer'               => true,
				'data-endpoint'       => esc_url_raw( $endpoint ),
				'data-project'        => (string) $settings['project_key'],
				'data-access'         => (string) $settings['access_key'],
				'data-always-on'      => 'true',
				'data-reporter-name'  => wp_specialchars_decode( (string) $user->display_name, ENT_QUOTES ),
				'data-reporter-email' => (string) $user->user_email,
				'data-position'       => (string) $settings['position'],
			)
		);
	}

	/**
	 * Everyone else: a tiny loader that fetches the widget only for ?annotate= links or
	 * browsers that already opened one. The catcher is installed only in that case too,
	 * so regular visitors run nothing but the check.
	 *
	 * @param array<string, mixed> $settings Settings.
	 */
	private function print_loader( array $settings ): void {
		$endpoint = annotate_endpoint();
		$flags    = JSON_HEX_TAG | JSON_HEX_AMP | JSON_HEX_APOS | JSON_HEX_QUOT;

		$js = strtr(
			self::loader_template(),
			array(
				'__ANNOTATE_PROJECT__'  => wp_json_encode( (string) $settings['project_key'], $flags ),
				'__ANNOTATE_SRC__'      => wp_json_encode( esc_url_raw( $endpoint . '/widget.js' ), $flags ),
				'__ANNOTATE_ENDPOINT__' => wp_json_encode( esc_url_raw( $endpoint ), $flags ),
				'__ANNOTATE_POSITION__' => wp_json_encode( (string) $settings['position'], $flags ),
				'__ANNOTATE_CATCHER__'  => self::catcher_js(),
			)
		);

		wp_print_inline_script_tag( $js, array( 'id' => 'annotate-loader' ) );
	}

	/**
	 * Admin bar "Report issue" (frontend only, authorized users).
	 *
	 * @param WP_Admin_Bar $bar Admin bar.
	 */
	public function add_admin_bar_node( $bar ): void {
		if ( ! $bar instanceof WP_Admin_Bar || ! $this->is_eligible_request() ) {
			return;
		}
		if ( ! $this->user_is_authorized( annotate_get_settings() ) ) {
			return;
		}

		$bar->add_node(
			array(
				'id'    => self::ADMIN_BAR_NODE,
				'title' => '<span class="ab-icon dashicons dashicons-format-chat" aria-hidden="true"></span><span class="ab-label">' . esc_html__( 'Report issue', 'annotate' ) . '</span>',
				'href'  => '#',
				'meta'  => array(
					'title' => __( 'Report an issue on this page', 'annotate' ),
				),
			)
		);
	}

	/**
	 * Delegated click handler for the admin-bar node (no inline onclick, so strict CSP still works).
	 */
	private static function admin_bar_js(): string {
		$selector = wp_json_encode( '#wp-admin-bar-' . self::ADMIN_BAR_NODE . ' a', JSON_HEX_TAG );
		return 'document.addEventListener("click",function(e){var t=e.target,a=t&&t.closest?t.closest(' . $selector . '):null;if(!a)return;e.preventDefault();window.Annotate&&window.Annotate.open();});';
	}

	/**
	 * Early error catcher: fills window.__annotateErrors (last 20) from window "error",
	 * "unhandledrejection" and console.error (the original console.error still runs).
	 */
	private static function catcher_js(): string {
		return <<<'JS'
(function(w){
	if (w.__annotateErrors) return;
	var buf = w.__annotateErrors = [];
	function str(v){
		try {
			if (typeof v === 'string') return v;
			if (v instanceof Error) return v.message;
			var s = JSON.stringify(v);
			return s === undefined ? String(v) : s;
		} catch (e) {
			try { return String(v); } catch (e2) { return ''; }
		}
	}
	function push(kind, message, stack){
		try {
			var entry = { kind: kind, message: String(message || '').slice(0, 2000), at: Date.now() };
			if (stack) entry.stack = String(stack).slice(0, 4000);
			buf.push(entry);
			if (buf.length > 20) buf.splice(0, buf.length - 20);
		} catch (e) {}
	}
	w.addEventListener('error', function(ev){
		var err = ev.error;
		push('error', ev.message || (err && err.message) || 'Script error', err && err.stack);
	});
	w.addEventListener('unhandledrejection', function(ev){
		var r = ev.reason;
		push('unhandledrejection', r && r.message ? r.message : str(r), r && r.stack);
	});
	var c = w.console, orig = c && c.error;
	if (typeof orig === 'function') {
		c.error = function(){
			try {
				var parts = [], stack;
				for (var i = 0; i < arguments.length; i++) {
					var a = arguments[i];
					if (!stack && a instanceof Error) stack = a.stack;
					parts.push(str(a));
				}
				push('console.error', parts.join(' '), stack);
			} catch (e) {}
			return orig.apply(this, arguments);
		};
	}
})(window);
JS;
	}

	/**
	 * Access-link loader. Placeholders are replaced with JSON-encoded values.
	 */
	private static function loader_template(): string {
		return <<<'JS'
(function(w, d){
	var project = __ANNOTATE_PROJECT__;
	var on = /[?&]annotate=/.test(w.location.search);
	if (!on) {
		try { on = !!w.localStorage.getItem('annotate:access:' + project); } catch (e) {}
	}
	if (!on) return;
	__ANNOTATE_CATCHER__
	var s = d.createElement('script');
	var cur = d.currentScript;
	if (cur && cur.nonce) s.nonce = cur.nonce;
	s.src = __ANNOTATE_SRC__;
	s.async = true;
	s.setAttribute('data-endpoint', __ANNOTATE_ENDPOINT__);
	s.setAttribute('data-project', project);
	s.setAttribute('data-position', __ANNOTATE_POSITION__);
	(d.head || d.documentElement).appendChild(s);
})(window, document);
JS;
	}
}
