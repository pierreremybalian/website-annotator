<?php
/**
 * Frontend: page context, early error catcher, widget script tag or access-link loader,
 * block hints (data-annotate-block), admin-bar "Report issue".
 *
 * @package Annotate
 */

defined( 'ABSPATH' ) || exit;

/**
 * Injects the widget on the public site.
 */
class Annotate_Frontend {

	const ADMIN_BAR_NODE = 'annotate-report';
	const BLOCK_ATTR     = 'data-annotate-block';

	/**
	 * PageContext max size as JSON (shared contract).
	 */
	const MAX_CONTEXT_BYTES = 4096;

	/**
	 * Template file WordPress settled on (template_include), absolute. Only ever output relative.
	 *
	 * @var string
	 */
	private string $template = '';

	/**
	 * Whether block hints are on for this request; null until decided.
	 *
	 * @var bool|null
	 */
	private ?bool $block_hints = null;

	/**
	 * Register hooks.
	 */
	public function register(): void {
		add_action( 'wp_head', array( $this, 'print_head' ), 1 );
		add_action( 'admin_bar_menu', array( $this, 'add_admin_bar_node' ), 80 );
		// Last, so the template recorded is the one other plugins and the theme settled on.
		add_filter( 'template_include', array( $this, 'capture_template' ), PHP_INT_MAX );
		// WP_HTML_Tag_Processor: WP 6.2+.
		if ( class_exists( 'WP_HTML_Tag_Processor' ) ) {
			add_filter( 'render_block', array( $this, 'add_block_hint' ), 20, 2 );
		}
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

		$inline = self::context_js( $this->page_context() ) . "\n" . self::catcher_js();
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
	 * browsers that already opened one. The page context and the catcher are set only in
	 * that case too, so regular visitors run nothing but the check.
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
				'__ANNOTATE_CONTEXT__'  => self::context_json( $this->page_context() ),
				'__ANNOTATE_CATCHER__'  => self::catcher_js(),
			)
		);

		wp_print_inline_script_tag( $js, array( 'id' => 'annotate-loader' ) );
	}

	/**
	 * Record the template file (template_include, last priority). Returns it unchanged.
	 *
	 * @param mixed $template Template path.
	 * @return mixed
	 */
	public function capture_template( $template ) {
		$this->template = is_string( $template ) ? $template : '';
		return $template;
	}

	/**
	 * Page context for window.AnnotateContext:
	 * { platform, postId, postType, template, slug, isFrontPage, theme } plus, when they apply,
	 * templateTheme (the template is in the parent theme), templateId (block themes),
	 * taxonomy and termId (term archives). Paths are relative to the theme directory; never absolute.
	 *
	 * Filter: annotate_page_context( array $context ) to add fields. A filtered result that isn't an
	 * array or is over 4 KB as JSON is ignored.
	 *
	 * @return array<string, mixed>
	 */
	private function page_context(): array {
		$object    = get_queried_object();
		$post_id   = null;
		$post_type = null;
		$slug      = null;
		$extra     = array();

		if ( $object instanceof WP_Post ) {
			$post_id   = (int) $object->ID;
			$post_type = (string) $object->post_type;
			$slug      = (string) $object->post_name;
		} elseif ( $object instanceof WP_Term ) {
			$slug              = (string) $object->slug;
			$extra['taxonomy'] = (string) $object->taxonomy;
			$extra['termId']   = (int) $object->term_id;
		} elseif ( $object instanceof WP_Post_Type ) {
			$post_type = (string) $object->name;
		} elseif ( $object instanceof WP_User ) {
			$slug = (string) $object->user_nicename;
		}

		$context = array_merge(
			array(
				'platform'    => 'wordpress',
				'postId'      => $post_id,
				'postType'    => $post_type,
				'template'    => null,
				'slug'        => '' !== $slug ? $slug : null,
				'isFrontPage' => is_front_page(),
				'theme'       => get_stylesheet(),
			),
			$this->template_context(),
			$extra
		);

		$filtered = apply_filters( 'annotate_page_context', $context );
		if ( is_array( $filtered ) && $filtered !== $context ) {
			$json = wp_json_encode( $filtered );
			if ( false !== $json && strlen( $json ) <= self::MAX_CONTEXT_BYTES ) {
				$context = $filtered;
			}
		}
		return $context;
	}

	/**
	 * The template as a path relative to the theme that holds it.
	 *
	 * Classic themes: the file from template_include ("page-templates/landing.php"). Block themes:
	 * template_include is core's template-canvas.php, so this reports the block template id
	 * ("mytheme//single") and its file under templates/ when the theme has one. Templates from
	 * elsewhere (a plugin) are given relative to wp-content.
	 *
	 * @return array<string, string|null>
	 */
	private function template_context(): array {
		$file = '' !== $this->template ? wp_normalize_path( $this->template ) : '';

		$themes = array( get_stylesheet() => get_stylesheet_directory() );
		if ( get_template() !== get_stylesheet() ) {
			$themes[ get_template() ] = get_template_directory();
		}

		$relative = function ( string $path ) use ( $themes ): ?array {
			foreach ( $themes as $slug => $dir ) {
				$dir = trailingslashit( wp_normalize_path( $dir ) );
				if ( str_starts_with( $path, $dir ) ) {
					$out = array( 'template' => substr( $path, strlen( $dir ) ) );
					if ( get_stylesheet() !== $slug ) {
						$out['templateTheme'] = (string) $slug;
					}
					return $out;
				}
			}
			return null;
		};

		if ( '' !== $file ) {
			$in_theme = $relative( $file );
			if ( null !== $in_theme ) {
				return $in_theme;
			}
		}

		global $_wp_current_template_id;
		if ( is_string( $_wp_current_template_id ) && '' !== $_wp_current_template_id ) {
			$out   = array(
				'template'   => null,
				'templateId' => $_wp_current_template_id,
			);
			$parts = explode( '//', $_wp_current_template_id, 2 );
			$name  = sanitize_file_name( end( $parts ) );
			if ( '' !== $name ) {
				$folder = function_exists( 'get_block_theme_folders' ) ? get_block_theme_folders()['wp_template'] : 'templates';
				foreach ( $themes as $dir ) {
					$candidate = wp_normalize_path( trailingslashit( $dir ) . $folder . '/' . $name . '.html' );
					if ( is_file( $candidate ) ) {
						$out = array_merge( $out, (array) $relative( $candidate ) );
						break;
					}
				}
			}
			return $out;
		}

		if ( '' === $file ) {
			return array();
		}
		$content = trailingslashit( wp_normalize_path( WP_CONTENT_DIR ) );
		return array( 'template' => str_starts_with( $file, $content ) ? substr( $file, strlen( $content ) ) : wp_basename( $file ) );
	}

	/**
	 * Context as JSON safe inside an inline <script> (<, >, &, ' and " are \u-escaped).
	 *
	 * @param array<string, mixed> $context Context.
	 */
	private static function context_json( array $context ): string {
		$json = wp_json_encode( $context, JSON_HEX_TAG | JSON_HEX_AMP | JSON_HEX_APOS | JSON_HEX_QUOT | JSON_UNESCAPED_SLASHES );
		return false === $json ? '{"platform":"wordpress"}' : $json;
	}

	/**
	 * window.AnnotateContext = {...}; for the authorized-user inline script.
	 *
	 * @param array<string, mixed> $context Context.
	 */
	private static function context_js( array $context ): string {
		return 'window.AnnotateContext = ' . self::context_json( $context ) . ';';
	}

	/**
	 * Whether this request gets block hints: a connected frontend page where the widget can be
	 * used (the user has the capability, or access links are on). Decided once, after the main query.
	 */
	private function block_hints_enabled(): bool {
		if ( null !== $this->block_hints ) {
			return $this->block_hints;
		}
		if ( ! did_action( 'wp' ) ) {
			return false; // Too early to tell (is_feed() etc. need the main query); don't cache.
		}
		$enabled = false;
		if ( $this->is_eligible_request() ) {
			$settings = annotate_get_settings();
			$enabled  = $this->user_is_authorized( $settings ) || (bool) $settings['access_links'];
		}
		/**
		 * Filter: annotate_block_hints( bool $enabled ). Return false to never add data-annotate-block.
		 */
		$this->block_hints = (bool) apply_filters( 'annotate_block_hints', $enabled );
		return $this->block_hints;
	}

	/**
	 * render_block: add data-annotate-block="<block name>" to the first tag of the block's HTML.
	 *
	 * Only the block name (e.g. "acf/hero", "core/group"), never a file path. Skips blocks without a
	 * name (classic content) and core/freeform, HTML that doesn't start with a tag, and an existing
	 * attribute: inner blocks render first, so a wrapper-less parent (core/block, core/pattern)
	 * keeps the inner block's name, which is the nearer one.
	 *
	 * @param mixed $block_content Rendered block HTML.
	 * @param mixed $block         Parsed block.
	 * @return mixed
	 */
	public function add_block_hint( $block_content, $block ) {
		if ( ! is_string( $block_content ) || '' === $block_content || ! is_array( $block ) ) {
			return $block_content;
		}
		$name = isset( $block['blockName'] ) && is_string( $block['blockName'] ) ? $block['blockName'] : '';
		if ( '' === $name || 'core/freeform' === $name || ! preg_match( '#^[a-z][a-z0-9-]*/[a-z][a-z0-9-]*$#', $name ) ) {
			return $block_content;
		}
		if ( '<' !== substr( ltrim( $block_content ), 0, 1 ) || ! $this->block_hints_enabled() ) {
			return $block_content;
		}

		$tags = new WP_HTML_Tag_Processor( $block_content );
		// Look past leading <style>/<script> (some blocks print one before their wrapper).
		for ( $i = 0; $i < 4 && $tags->next_tag(); $i++ ) {
			if ( in_array( $tags->get_tag(), array( 'STYLE', 'SCRIPT', 'LINK', 'META', 'NOSCRIPT', 'TEMPLATE' ), true ) ) {
				continue;
			}
			if ( null !== $tags->get_attribute( self::BLOCK_ATTR ) ) {
				return $block_content;
			}
			$tags->set_attribute( self::BLOCK_ATTR, $name );
			return $tags->get_updated_html();
		}
		return $block_content;
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
	w.AnnotateContext = __ANNOTATE_CONTEXT__;
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
