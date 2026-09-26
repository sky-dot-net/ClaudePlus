import { createElement } from '../dom/createElement.js';

/**
 * The always-on-top button that starts (or re-shows) ClaudePlus. It exists independently of the
 * rest of the app and carries its own inline styling, so it works before ClaudePlus's own
 * stylesheet is injected - which, until the first click, it never is: nothing else about
 * ClaudePlus loads until this is clicked, so a page nobody interacts with (such as the hidden
 * iframes the widget extractor briefly opens) never pays for it.
 */
export class ClaudePlusLauncher {
  /**
   * The button element.
   * @type {HTMLElement}
   */
  #button;

  /**
   * Creates the launcher.
   * @param {function(): void} onActivate Called when the button is clicked.
   */
  constructor(onActivate) {
    this.#button = createElement('button', {
      className: 'claude-plus-launcher',
      textContent: '💡',
      title: 'Open ClaudePlus',
      style: ClaudePlusLauncher.#style(),
    });
    this.#button.addEventListener('click', onActivate);
  }

  /**
   * Adds the button to the page.
   * @returns {void}
   */
  mount() {
    document.body.append(this.#button);
  }

  /**
   * Shows the button; only the native claude.ai UI should have it visible.
   * @returns {void}
   */
  show() {
    this.#button.style.display = '';
  }

  /**
   * Hides the button while ClaudePlus's own workspace is showing.
   * @returns {void}
   */
  hide() {
    this.#button.style.display = 'none';
  }

  /**
   * The button's inline styling, self-contained so it renders correctly before ClaudePlus's own
   * stylesheet exists.
   * @returns {string} The CSS text.
   */
  static #style() {
    return [
      'position:fixed', 'right:16px', 'bottom:16px', 'width:44px', 'height:44px', 'border-radius:50%',
      'border:none', 'background:#1a1918', 'box-shadow:0 2px 8px rgba(0,0,0,0.4)', 'font-size:20px',
      'line-height:44px', 'text-align:center', 'padding:0', 'cursor:pointer', 'z-index:2147483647',
    ].join(';');
  }
}
