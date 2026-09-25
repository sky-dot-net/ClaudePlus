import { LAYOUT } from '../config/LAYOUT.js';

/**
 * Stylesheet of the whole UI.
 * @type {string}
 */
export const STYLES = `
  :root {
    --claude-plus-color-background: #1a1918;
    --claude-plus-color-bar: #1c1b1a;
    --claude-plus-color-raised: #262523;
    --claude-plus-color-raised-hover: #3a3937;
    --claude-plus-color-human-message: #2a2927;
    --claude-plus-color-tool-details: #232221;
    --claude-plus-color-code-block: #101010;
    --claude-plus-color-button: #333;
    --claude-plus-color-button-hover: #444;
    --claude-plus-color-text: #ececec;
    --claude-plus-color-text-muted: #b8b6b3;
    --claude-plus-color-text-faint: #8a8886;
    --claude-plus-color-accent: #d97757;
    --claude-plus-color-accent-soft: rgba(217, 119, 87, 0.18);
    --claude-plus-color-accent-overlay: rgba(217, 119, 87, 0.35);
    --claude-plus-color-error: #e57373;
    --claude-plus-color-active-chat: rgba(94, 200, 120, 0.55);
    --claude-plus-color-border-faint: rgba(255, 255, 255, 0.05);
    --claude-plus-color-border: rgba(255, 255, 255, 0.08);
    --claude-plus-color-border-strong: rgba(255, 255, 255, 0.12);
    --claude-plus-color-hover: rgba(255, 255, 255, 0.06);
    --claude-plus-font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    --claude-plus-layer-zone-chrome: 2147480000;
    --claude-plus-layer-panel: 2147480500;
    --claude-plus-layer-divider: 2147480600;
    --claude-plus-layer-toolbar: 2147483000;
    --claude-plus-layer-popup-menu: 2147483001;
    --claude-plus-layer-drop-highlight: 2147483646;
    --claude-plus-layer-drag-label: 2147483647;
  }
  .claude-plus-themed { font-family: var(--claude-plus-font-family); color: var(--claude-plus-color-text); color-scheme: dark; }
  .claude-plus-themed [hidden], .claude-plus-themed[hidden], .claude-plus-drop-highlight[hidden] { display: none !important; }
  html.claude-plus-resizing-horizontally, html.claude-plus-resizing-horizontally * { cursor: col-resize !important; user-select: none; }
  html.claude-plus-resizing-vertically, html.claude-plus-resizing-vertically * { cursor: row-resize !important; user-select: none; }

  .claude-plus-toolbar { position: fixed; top: 0; left: 0; right: 0; height: ${LAYOUT.toolbarHeight}px; z-index: var(--claude-plus-layer-toolbar); background: var(--claude-plus-color-bar); border-bottom: 1px solid var(--claude-plus-color-border-strong); display: flex; align-items: center; gap: 14px; padding: 0 10px; font-size: 12px; box-sizing: border-box; }
  .claude-plus-toolbar__title { font-weight: 600; }
  .claude-plus-toolbar__button { background: var(--claude-plus-color-button); border: none; color: var(--claude-plus-color-text); padding: 5px 10px; border-radius: 6px; cursor: pointer; font-size: 12px; }
  .claude-plus-toolbar__button:hover { background: var(--claude-plus-color-button-hover); }
  .claude-plus-toolbar__button:disabled { opacity: 0.5; cursor: default; }
  .claude-plus-toolbar__font-size { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
  .claude-plus-toolbar__font-size input[type=range] { width: 100px; }

  .claude-plus-zone-chrome-layer { position: fixed; inset: 0; pointer-events: none; z-index: var(--claude-plus-layer-zone-chrome); }
  .claude-plus-zone-frame { position: fixed; background: var(--claude-plus-color-background); border: 1px solid var(--claude-plus-color-border); box-sizing: border-box; }
  .claude-plus-tab-strip { position: fixed; display: flex; align-items: center; background: var(--claude-plus-color-bar); border-bottom: 1px solid var(--claude-plus-color-border); overflow-x: auto; box-sizing: border-box; pointer-events: auto; }
  .claude-plus-tab { padding: 5px 12px; font-size: 12px; color: var(--claude-plus-color-text-muted); cursor: pointer; white-space: nowrap; border-right: 1px solid var(--claude-plus-color-border-faint); user-select: none; }
  .claude-plus-tab--active { color: var(--claude-plus-color-text); border-bottom: 2px solid var(--claude-plus-color-accent); }
  .claude-plus-tab { display: flex; align-items: center; min-width: 0; max-width: 220px; }
  .claude-plus-tab__label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .claude-plus-tab__close-button { flex-shrink: 0; margin-left: 8px; padding: 0 3px; border-radius: 3px; color: var(--claude-plus-color-text-faint); }
  .claude-plus-tab__close-button:hover { background: var(--claude-plus-color-hover); color: var(--claude-plus-color-text); }
  .claude-plus-tab-strip__add-button { padding: 5px 10px; cursor: pointer; color: var(--claude-plus-color-text-faint); user-select: none; }
  .claude-plus-tab-strip__add-button:hover { color: var(--claude-plus-color-text); }
  .claude-plus-divider-layer { position: fixed; inset: 0; pointer-events: none; z-index: var(--claude-plus-layer-divider); }
  .claude-plus-divider { position: fixed; pointer-events: auto; background: transparent; }
  .claude-plus-divider--vertical { cursor: col-resize; }
  .claude-plus-divider--horizontal { cursor: row-resize; }
  .claude-plus-divider:hover { background: var(--claude-plus-color-accent); }
  .claude-plus-drag-label { position: fixed; z-index: var(--claude-plus-layer-drag-label); background: var(--claude-plus-color-accent); color: #fff; padding: 4px 10px; border-radius: 6px; font-size: 12px; pointer-events: none; }
  .claude-plus-drop-highlight { position: fixed; z-index: var(--claude-plus-layer-drop-highlight); background: var(--claude-plus-color-accent-overlay); border: 2px solid var(--claude-plus-color-accent); pointer-events: none; box-sizing: border-box; }
  .claude-plus-popup-menu { position: fixed; z-index: var(--claude-plus-layer-popup-menu); background: var(--claude-plus-color-raised); border: 1px solid var(--claude-plus-color-border-strong); border-radius: 6px; padding: 4px; min-width: 140px; font-size: 12px; }
  .claude-plus-popup-menu__entry { padding: 6px 10px; cursor: pointer; border-radius: 4px; }
  .claude-plus-popup-menu__entry:hover { background: var(--claude-plus-color-raised-hover); }

  .claude-plus-dialog-overlay { position: fixed; inset: 0; z-index: var(--claude-plus-layer-drag-label); background: rgba(0, 0, 0, 0.5); display: flex; align-items: center; justify-content: center; }
  .claude-plus-dialog { background: var(--claude-plus-color-raised); border: 1px solid var(--claude-plus-color-border-strong); border-radius: 8px; padding: 16px; max-width: 360px; font-size: 13px; }
  .claude-plus-dialog__message { margin: 0 0 14px; line-height: 1.4; }
  .claude-plus-dialog__input { width: 100%; box-sizing: border-box; margin: 0 0 14px; padding: 6px 8px; background: var(--claude-plus-color-bar); border: 1px solid var(--claude-plus-color-border-strong); border-radius: 6px; color: var(--claude-plus-color-text); font: inherit; }
  .claude-plus-dialog__actions { display: flex; justify-content: flex-end; gap: 8px; }

  .claude-plus-image-viewer-overlay { position: fixed; inset: 0; z-index: var(--claude-plus-layer-drag-label); background: rgba(0, 0, 0, 0.8); display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; }
  .claude-plus-image-viewer__frame { max-width: 90vw; max-height: 90vh; overflow: hidden; display: flex; align-items: center; justify-content: center; }
  .claude-plus-image-viewer__image { max-width: 90vw; max-height: 90vh; width: auto; height: auto; cursor: grab; user-select: none; }
  .claude-plus-image-viewer__open-button { flex-shrink: 0; }

  .claude-plus-panel { position: fixed; z-index: var(--claude-plus-layer-panel); box-sizing: border-box; padding: 10px 12px; overflow-y: auto; display: flex; flex-direction: column; gap: 8px; font-size: 13px; background: var(--claude-plus-color-background); }
  .claude-plus-panel summary { cursor: pointer; padding: 4px 0; }
  .claude-plus-panel--active-among-several { box-shadow: inset 0 0 0 1px var(--claude-plus-color-active-chat); }
  .claude-plus-panel select, .claude-plus-panel input[type=text], .claude-plus-panel input[type=date], .claude-plus-panel textarea { background: var(--claude-plus-color-bar); border: 1px solid var(--claude-plus-color-border-strong); border-radius: 6px; color: var(--claude-plus-color-text); font-size: 12px; font-family: inherit; }
  .claude-plus-panel__section { padding: 8px 0; border-bottom: 1px solid var(--claude-plus-color-hover); flex-shrink: 0; }
  .claude-plus-panel__section:last-child { border-bottom: none; }
  .claude-plus-value-row { display: flex; justify-content: space-between; padding: 2px 0; gap: 8px; }
  .claude-plus-value-row span { color: var(--claude-plus-color-text-muted); }
  .claude-plus-spaced-above { margin-top: 6px; }
  .claude-plus-hint { color: var(--claude-plus-color-text-faint); font-size: 11px; margin-top: 4px; }
  .claude-plus-scrollable { overflow-y: auto; }
  .claude-plus-fill-remaining { flex: 1; min-height: 0; }
  .claude-plus-empty-state { color: var(--claude-plus-color-text-faint); font-style: italic; padding: 6px 0; }
  .claude-plus-empty-state--padded { padding: 24px; }
  .claude-plus-pending { opacity: 0.4; pointer-events: none; }
  .claude-plus-primary-button { padding: 8px; background: var(--claude-plus-color-accent); border: none; border-radius: 6px; color: #fff; font-size: 13px; cursor: pointer; font-weight: 600; flex-shrink: 0; }
  .claude-plus-primary-button:disabled { opacity: 0.6; cursor: default; }
  .claude-plus-full-width { width: 100%; }

  .claude-plus-search-input { flex-shrink: 0; padding: 6px 8px; }
  .claude-plus-conversation:hover .claude-plus-conversation__action-button { visibility: visible; }
  .claude-plus-conversation { cursor: pointer; }
  .claude-plus-conversation:hover > td { background: var(--claude-plus-color-hover); }
  .claude-plus-conversation--active > td { background: var(--claude-plus-color-accent-soft); }
  .claude-plus-conversation--open-elsewhere > td:first-child { box-shadow: inset 2px 0 0 var(--claude-plus-color-accent); }
  .claude-plus-conversation__actions { display: inline-flex; white-space: nowrap; }
  .claude-plus-search-result, .claude-plus-folder { cursor: pointer; }
  .claude-plus-search-result:hover > td, .claude-plus-folder:hover > td { background: var(--claude-plus-color-hover); }
  .claude-plus-conversation__action-button { visibility: hidden; background: none; border: none; cursor: pointer; font-size: 12px; padding: 4px; border-radius: 4px; flex-shrink: 0; }
  .claude-plus-conversation__action-button:hover { background: rgba(255, 255, 255, 0.1); }

  .claude-plus-message-list { display: flex; flex-direction: column; gap: 14px; }
  .claude-plus-message { padding: 10px 12px; border-radius: 8px; max-width: 100%; }
  .claude-plus-message--human { background: var(--claude-plus-color-human-message); align-self: flex-end; }
  .claude-plus-message--assistant { background: transparent; }
  .claude-plus-message__sender { font-size: 11px; color: var(--claude-plus-color-text-faint); margin-bottom: 4px; font-weight: 600; }
  .claude-plus-message__body { font-size: var(--claude-plus-message-font-size, 14px); line-height: 1.5; overflow-wrap: break-word; }
  .claude-plus-message__actions { display: flex; gap: 8px; margin-top: 6px; }
  .claude-plus-message__action-button { background: none; border: none; color: var(--claude-plus-color-text-faint); cursor: pointer; font-size: 11px; padding: 2px 6px; border-radius: 4px; }
  .claude-plus-message__action-button:hover { background: var(--claude-plus-color-border); color: var(--claude-plus-color-text); }
  .claude-plus-message-text { white-space: normal; }
  .claude-plus-message-text a { color: var(--claude-plus-color-accent); }
  .claude-plus-message-attachment { color: var(--claude-plus-color-text-muted); font-size: 12px; margin-bottom: 4px; }
  .claude-plus-message-image { display: block; max-height: 300px; max-width: 100%; border-radius: 8px; margin-bottom: 6px; cursor: zoom-in; }
  .claude-plus-message-error { color: var(--claude-plus-color-error); margin-top: 6px; }
  .claude-plus-tool-details { margin: 6px 0; background: var(--claude-plus-color-tool-details); border-radius: 6px; padding: 4px 8px; font-size: 12px; }
  .claude-plus-tool-details pre { white-space: pre-wrap; overflow-wrap: break-word; font-size: 11px; color: var(--claude-plus-color-text-muted); }
  .claude-plus-code-block { background: var(--claude-plus-color-code-block); padding: 8px; border-radius: 6px; overflow-x: auto; font-size: 12px; }
  .claude-plus-streaming-cursor { animation: claude-plus-blink 1s step-start infinite; }
  @keyframes claude-plus-blink { 50% { opacity: 0; } }

  .claude-plus-composer__options { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; flex-shrink: 0; }
  .claude-plus-composer__options select { padding: 4px 6px; }
  .claude-plus-composer__thinking-toggle { display: flex; align-items: center; gap: 4px; font-size: 12px; color: var(--claude-plus-color-text-muted); cursor: pointer; }
  .claude-plus-panel .claude-plus-composer__input { flex: 1; resize: none; min-height: 40px; border-radius: 8px; padding: 8px; font-size: 14px; }

  .claude-plus-staged-files { display: flex; flex-wrap: wrap; gap: 6px; flex-shrink: 0; }
  .claude-plus-staged-file { display: inline-flex; align-items: center; gap: 4px; background: var(--claude-plus-color-bar); border: 1px solid var(--claude-plus-color-border-strong); border-radius: 6px; padding: 3px 4px 3px 3px; font-size: 12px; max-width: 200px; }
  .claude-plus-staged-file--uploading { opacity: 0.6; }
  .claude-plus-staged-file__thumb { width: 20px; height: 20px; border-radius: 4px; object-fit: cover; flex-shrink: 0; }
  .claude-plus-staged-file__icon { flex-shrink: 0; }
  .claude-plus-staged-file__name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .claude-plus-staged-file__remove { background: none; border: none; color: var(--claude-plus-color-text-faint); cursor: pointer; padding: 0 2px; border-radius: 4px; flex-shrink: 0; }
  .claude-plus-staged-file__remove:hover { background: var(--claude-plus-color-hover); color: var(--claude-plus-color-text); }


  .claude-plus-table-host { display: flex; flex-direction: column; gap: 4px; flex: 1; min-height: 0; }
  .claude-plus-column-table__column-picker { flex-shrink: 0; font-size: 11px; color: var(--claude-plus-color-text-muted); }
  .claude-plus-column-table__column-picker summary { padding: 0; }
  .claude-plus-column-table__column-toggle { display: inline-flex; align-items: center; gap: 4px; margin: 2px 10px 2px 0; cursor: pointer; }
  .claude-plus-column-table__table { width: 100%; border-collapse: collapse; font-size: 12px; }
  .claude-plus-column-table__table th { text-align: left; padding: 4px 6px; color: var(--claude-plus-color-text-muted); background: var(--claude-plus-color-raised); position: sticky; z-index: 1; white-space: nowrap; font-weight: 600; }
  .claude-plus-column-table__table thead tr:first-child th { top: 0; }
  .claude-plus-column-table__filter-row th { top: 24px; padding-top: 0; border-bottom: 1px solid var(--claude-plus-color-border-strong); font-weight: normal; }
  .claude-plus-column-table__sortable { cursor: pointer; user-select: none; }
  .claude-plus-column-table__sortable:hover { color: var(--claude-plus-color-text); }
  .claude-plus-panel .claude-plus-column-table__filter-input { display: block; width: 100%; min-width: 40px; box-sizing: border-box; padding: 2px 4px; font-size: 11px; }
  .claude-plus-panel input[type=date].claude-plus-column-table__filter-input { min-width: 0; max-width: 112px; padding: 1px 2px; font-size: 10px; }
  .claude-plus-panel input[type=date].claude-plus-column-table__filter-input + input[type=date] { margin-top: 2px; }
  .claude-plus-column-table__cell { padding: 4px 6px; border-bottom: 1px solid var(--claude-plus-color-border-faint); vertical-align: top; }
  .claude-plus-column-table__cell--name, .claude-plus-column-table__cell--title, .claude-plus-column-table__cell--match { width: 100%; max-width: 1px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .claude-plus-column-table__cell a { color: var(--claude-plus-color-accent); text-decoration: none; }
  .claude-plus-column-table__cell a:hover { text-decoration: underline; }
  .claude-plus-value-combobox { position: fixed; z-index: var(--claude-plus-layer-popup-menu); max-height: 240px; overflow-y: auto; background: var(--claude-plus-color-raised); border: 1px solid var(--claude-plus-color-border-strong); border-radius: 6px; padding: 4px; font-size: 12px; }
  .claude-plus-value-combobox__entry { padding: 4px 8px; border-radius: 4px; cursor: pointer; white-space: nowrap; }
  .claude-plus-value-combobox__entry:hover { background: var(--claude-plus-color-raised-hover); }

  .claude-plus-chat-layout { display: flex; gap: 8px; flex: 1; min-height: 0; }
  .claude-plus-chat-layout__center { display: flex; flex-direction: column; gap: 8px; flex: 1; min-width: 0; }
  .claude-plus-chat-layout__side { display: flex; flex-direction: column; gap: 8px; width: 300px; flex-shrink: 0; min-height: 0; }
  .claude-plus-chat-layout__top { display: flex; flex-direction: column; gap: 8px; flex-shrink: 0; }
  .claude-plus-chat-layout__side:empty, .claude-plus-chat-layout__top:empty { display: none; }
  .claude-plus-subpane { display: flex; flex-direction: column; gap: 4px; min-height: 0; flex: 1; padding: 6px; border: 1px solid var(--claude-plus-color-border-strong); border-radius: 6px; background: var(--claude-plus-color-bar); }
  .claude-plus-chat-layout__top .claude-plus-subpane { height: 200px; flex: none; }
  .claude-plus-subpane__header { display: flex; align-items: center; gap: 2px; flex-shrink: 0; }
  .claude-plus-subpane__title { flex: 1; min-width: 0; font-size: 12px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .claude-plus-subpane__button { background: none; border: none; color: var(--claude-plus-color-text-faint); cursor: pointer; padding: 2px 5px; border-radius: 4px; }
  .claude-plus-subpane__button:hover { background: var(--claude-plus-color-hover); color: var(--claude-plus-color-text); }
  .claude-plus-composer__stop-button { flex-shrink: 0; background: var(--claude-plus-color-button-hover); }

  .claude-plus-breadcrumb { font-size: 12px; color: var(--claude-plus-color-text-muted); margin-bottom: 6px; flex-shrink: 0; }
  .claude-plus-breadcrumb__back-link { color: var(--claude-plus-color-accent); cursor: pointer; }
`;
