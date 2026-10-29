<?php
/**
 * Plugin Name:       Annotate – Website Feedback
 * Plugin URI:        https://github.com/pierreremybalian/website-annotator
 * Description:       Let your team and clients report website issues straight to Trello: drag a box over the problem, add a note, done.
 * Version:           0.2.0
 * Requires at least: 5.7
 * Requires PHP:      8.0
 * Author:            Pierre Balian
 * Author URI:        https://balian.dev
 * License:           GPL-2.0-or-later
 * License URI:       https://www.gnu.org/licenses/gpl-2.0.html
 * Text Domain:       annotate
 *
 * @package Annotate
 */

defined( 'ABSPATH' ) || exit;

define( 'ANNOTATE_VERSION', '0.2.0' );
define( 'ANNOTATE_FILE', __FILE__ );
define( 'ANNOTATE_DIR', plugin_dir_path( __FILE__ ) );
define( 'ANNOTATE_OPTION', 'annotate_settings' );
define( 'ANNOTATE_STATUS_TRANSIENT', 'annotate_status' );

// Can be overridden in wp-config.php, e.g. 'http://localhost:8787' for local development.
if ( ! defined( 'ANNOTATE_DEFAULT_ENDPOINT' ) ) {
	define( 'ANNOTATE_DEFAULT_ENDPOINT', 'https://annotate.pierre-51f.workers.dev' );
}

require_once ANNOTATE_DIR . 'includes/functions.php';
require_once ANNOTATE_DIR . 'includes/class-annotate-settings.php';
require_once ANNOTATE_DIR . 'includes/class-annotate-rest.php';
require_once ANNOTATE_DIR . 'includes/class-annotate-frontend.php';

/**
 * Wire up the plugin.
 */
function annotate_bootstrap(): void {
	( new Annotate_Settings() )->register();
	( new Annotate_Rest() )->register();
	( new Annotate_Frontend() )->register();
}
add_action( 'plugins_loaded', 'annotate_bootstrap' );
