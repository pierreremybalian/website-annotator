<?php
/**
 * Remove Annotate's options when the plugin is deleted.
 *
 * Only local settings are removed. The project on the Annotate server and the Trello cards stay.
 *
 * @package Annotate
 */

defined( 'WP_UNINSTALL_PLUGIN' ) || exit;

/**
 * Delete the plugin's data for the current site.
 */
function annotate_uninstall_site(): void {
	delete_option( 'annotate_settings' );
	delete_transient( 'annotate_status' );
}

if ( is_multisite() ) {
	foreach ( get_sites( array( 'fields' => 'ids' ) ) as $annotate_site_id ) {
		switch_to_blog( (int) $annotate_site_id );
		annotate_uninstall_site();
		restore_current_blog();
	}
} else {
	annotate_uninstall_site();
}
