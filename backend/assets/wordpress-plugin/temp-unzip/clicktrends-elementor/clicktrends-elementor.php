<?php
/**
 * Plugin Name: ClickTrends Elementor Deployer
 * Plugin URI: https://clicktrends.com.au
 * Description: Exposes a custom REST endpoint to allow ClickTrends to update Elementor page content dynamically.
 * Version: 1.0.0
 * Author: ClickTrends AI
 */

if (!defined('ABSPATH')) exit;

add_action('rest_api_init', function () {
    register_rest_route('clicktrends/v1', '/update-elementor/(?P<id>\d+)', array(
        'methods' => 'POST',
        'callback' => 'clicktrends_update_elementor',
        'permission_callback' => function () {
            // Must have edit capabilities to modify posts
            return current_user_can('edit_posts');
        }
    ));
});

function clicktrends_update_elementor($request) {
    $post_id = $request['id'];
    $search_text = $request->get_param('search_text');
    $replace_text = $request->get_param('replace_text');

    if (!$post_id || !$search_text || !$replace_text) {
        return new WP_Error('missing_params', 'Missing post ID, search text, or replace text.', array('status' => 400));
    }

    // Check if Elementor plugin is loaded
    if (!did_action('elementor/loaded')) {
        return new WP_Error('not_elementor', 'Elementor plugin is not active on this site.', array('status' => 400));
    }

    // Check if the post is actually built with Elementor
    if (!get_post_meta($post_id, '_elementor_edit_mode', true)) {
        return new WP_Error('not_elementor_page', 'This page is not built with Elementor.', array('status' => 400));
    }

    $elementor_data = get_post_meta($post_id, '_elementor_data', true);
    
    if (empty($elementor_data)) {
        return new WP_Error('empty_data', 'No Elementor data found for this page.', array('status' => 404));
    }

    $replaced = false;

    // Elementor data is usually a JSON string in postmeta, but sometimes WP unserializes it if stored differently
    if (is_string($elementor_data)) {
        // Decode to an array for safe replacement
        $data_array = json_decode($elementor_data, true);
        if (json_last_error() === JSON_ERROR_NONE && is_array($data_array)) {
            $modified_array = clicktrends_recursive_replace($search_text, $replace_text, $data_array, $replaced);
            $new_elementor_data = wp_slash(json_encode($modified_array));
        } else {
            // Fallback to raw string replacement
            $new_elementor_data = str_replace($search_text, $replace_text, $elementor_data, $count);
            if ($count > 0) $replaced = true;
        }
    } else if (is_array($elementor_data)) {
        $modified_array = clicktrends_recursive_replace($search_text, $replace_text, $elementor_data, $replaced);
        $new_elementor_data = wp_slash($modified_array);
    } else {
         return new WP_Error('invalid_data', 'Invalid Elementor data format.', array('status' => 500));
    }

    if (!$replaced) {
        return new WP_Error('no_match', 'The search text was not found in the Elementor data. It may be formatted differently.', array('status' => 404));
    }

    // Save the new data
    update_metadata('post', $post_id, '_elementor_data', $new_elementor_data);

    // Regenerate CSS cache for this specific post
    if (class_exists('\Elementor\Core\Files\CSS\Post')) {
        $post_css = new \Elementor\Core\Files\CSS\Post($post_id);
        $post_css->update();
    }
    
    // Clear global Elementor cache just to be completely safe
    if (class_exists('\Elementor\Plugin')) {
        \Elementor\Plugin::$instance->files_manager->clear_cache();
    }

    return rest_ensure_response(array(
        'success' => true,
        'message' => 'Elementor content updated successfully. CSS cache cleared.'
    ));
}

function clicktrends_recursive_replace($search, $replace, $array, &$replaced) {
    // Basic whitespace normalization for matching
    $normalized_search = preg_replace('/\s+/', ' ', trim($search));

    foreach ($array as $key => &$value) {
        if (is_array($value)) {
            $value = clicktrends_recursive_replace($search, $replace, $value, $replaced);
        } else if (is_string($value)) {
            // Try an exact match first
            if (strpos($value, $search) !== false) {
                $value = str_replace($search, $replace, $value);
                $replaced = true;
            } else {
                // Try matching with normalized whitespace (often Elementor saves strings with \n or weird spaces)
                // We strip HTML tags from the target string temporarily to check for a match
                $stripped_val = strip_tags($value);
                $normalized_val = preg_replace('/\s+/', ' ', trim($stripped_val));
                
                if (strpos($normalized_val, $normalized_search) !== false) {
                    // Since it matched when normalized, we do a naive replacement
                    // Note: This might replace HTML if the exact string spanned across tags.
                    // To be safe, we just replace the whole value if it's very similar
                    if (strlen($stripped_val) < strlen($search) + 50) {
                        // If it's a short text node that mostly matches, just overwrite it
                        $value = $replace;
                        $replaced = true;
                    }
                }
            }
        }
    }
    return $array;
}
