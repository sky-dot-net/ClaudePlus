/**
 * Tool names claude.ai treats as interactive display widgets rather than ordinary tool calls; a
 * call to one of these renders as a card inline in the message, not hidden in its "thinking and
 * tool calls" sub-pane like an ordinary tool call.
 * @type {ReadonlyArray<string>}
 */
export const WIDGET_TOOL_NAMES = Object.freeze([
  'weather_fetch',
  'recipe_display_v0',
  'places_map_display_v0',
  'message_compose_v1',
  'ask_user_input_v0',
  'recommend_claude_apps',
  'show_recommendation_cards',
  'chart_display_v0',
  'places_search',
  'fetch_sports_data',
  'options_card_display_v0',
  'step_card_display_v0',
  'itinerary_display_v0',
  'translation_display_v0',
  'comparison_card_display_v0',
  'featured_card_display_v0',
  'product_carousel_display_v0',
  'link_preview_display_v0',
  'places_list_display_v0',
  'quiz_display_v0',
]);
