/** Local browser display capabilities. Never serialize these choices to a team
 * draft: display identities/positions belong only to the operator's computer. */
export interface DetailedDisplay {
  readonly label?: string;
  readonly isPrimary?: boolean;
  readonly isInternal?: boolean;
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
  readonly availLeft: number;
  readonly availTop: number;
  readonly availWidth: number;
  readonly availHeight: number;
}
interface DisplayDetails {
  readonly screens: readonly DetailedDisplay[];
  readonly currentScreen: DetailedDisplay;
  addEventListener(type: string, listener: EventListener): void;
  removeEventListener(type: string, listener: EventListener): void;
}
export interface ConnectedDisplay {
  readonly id: string;
  readonly label: string;
  readonly isPrimary: boolean;
  readonly isCurrent: boolean;
  readonly isInternal: boolean;
  readonly width: number;
  readonly height: number;
}
export interface DisplayList {
  status: 'available' | 'unsupported' | 'denied' | 'insecure' | 'unavailable';
  displays: ConnectedDisplay[];
  message: string;
  /** Emits fresh choices on plug/unplug, resolution or current-screen changes. */
  subscribe(listener: (displays: ConnectedDisplay[]) => void): () => void;
}
export interface DisplayBrowser {
  readonly isSecureContext: boolean;
  readonly location: { href: string; origin: string };
  getScreenDetails?: () => Promise<DisplayDetails>;
  open(url: string, target: string, features: string): Window | null;
}
export interface OpenDisplayResult {
  status: 'opened' | 'blocked' | 'disconnected' | 'invalid-url' | 'unavailable';
  window: Window | null;
  placed: boolean;
  fullscreenRequired: boolean;
  message: string;
}

const screens = new WeakMap<ConnectedDisplay, { screen: DetailedDisplay; details: DisplayDetails }>();
const screenIds = new WeakMap<DetailedDisplay, string>();
let screenSerial = 0;
const browserWindow = () => typeof window === 'undefined' ? null : window as unknown as DisplayBrowser;
const unsubscribeNothing = () => {};

function choices(details: DisplayDetails): ConnectedDisplay[] {
  return details.screens.slice(0, 16).filter(screen =>
    [screen.left, screen.top, screen.width, screen.height, screen.availLeft, screen.availTop, screen.availWidth, screen.availHeight].every(Number.isFinite)
    && screen.width > 0 && screen.height > 0 && screen.availWidth > 0 && screen.availHeight > 0,
  ).map((screen, index) => {
    let id = screenIds.get(screen);
    if (!id) { id = `display-${++screenSerial}`; screenIds.set(screen, id); }
    const display: ConnectedDisplay = {
      id, label: screen.label?.trim().slice(0, 120) || (screen.isInternal ? 'Built-in display' : `Display ${index + 1}`),
      isPrimary: screen.isPrimary === true, isCurrent: screen === details.currentScreen, isInternal: screen.isInternal === true,
      width: Math.round(screen.width), height: Math.round(screen.height),
    };
    screens.set(display, { screen, details });
    return display;
  });
}

/** Call only from the operator's explicit Find displays/Refresh displays action.
 * Merely importing this module never queries permissions or enumerates screens.
 * https://developer.mozilla.org/en-US/docs/Web/API/Window/getScreenDetails */
export async function listDisplays(browser: DisplayBrowser | null = browserWindow()): Promise<DisplayList> {
  const unavailable = (status: DisplayList['status'], message: string): DisplayList => ({ status, displays: [], message, subscribe: () => unsubscribeNothing });
  if (!browser) return unavailable('unavailable', 'Display selection is available in the Studio browser on this computer.');
  if (!browser.isSecureContext) return unavailable('insecure', 'Open Studio on localhost or HTTPS to find connected displays. You can still open an output window and move it manually.');
  if (!browser.getScreenDetails) return unavailable('unsupported', 'This browser cannot choose connected displays. Open the output, move it to your monitor or projector, then press F for fullscreen. Use a supporting Chrome or Edge browser for display selection.');
  try {
    const details = await browser.getScreenDetails();
    return { status: 'available', displays: choices(details), message: 'Choose a connected display. The output opens there; press F in its window for fullscreen if the browser requires it.',
      subscribe(listener) {
        const changed = () => listener(choices(details));
        details.addEventListener('screenschange', changed);
        details.addEventListener('currentscreenchange', changed);
        return () => { details.removeEventListener('screenschange', changed); details.removeEventListener('currentscreenchange', changed); };
      },
    };
  } catch (error) {
    if (error && typeof error === 'object' && 'name' in error && error.name === 'NotAllowedError') {
      return unavailable('denied', 'Display permission was not granted. Allow window management in this site’s browser settings and try again, or open the output and move it manually.');
    }
    return unavailable('unavailable', 'Connected displays could not be read. Check your display connection and try again, or open the output and move it manually.');
  }
}

/** Synchronous by design: invoke in a click handler, after any setup/save has
 * finished. No await or hidden permission prompt may consume the popup gesture.
 * Only same-origin Lumen pages are allowed to retain a controllable Window. */
export function openDisplayOutput(url: string, display: ConnectedDisplay | null = null,
  options: { windowName?: string; browser?: DisplayBrowser | null } = {}): OpenDisplayResult {
  const browser = options.browser === undefined ? browserWindow() : options.browser;
  const failed = (status: OpenDisplayResult['status'], message: string): OpenDisplayResult => ({ status, window: null, placed: false, fullscreenRequired: false, message });
  if (!browser) return failed('unavailable', 'Open this output from the Studio browser.');
  let target: URL;
  try {
    target = new URL(url, browser.location.href);
    if (!['http:', 'https:'].includes(target.protocol) || target.origin !== browser.location.origin || target.username || target.password) throw new Error();
  } catch { return failed('invalid-url', 'Choose a Lumen output link from this station.'); }
  const selected = display ? screens.get(display) : undefined;
  if (display && (!selected || !selected.details.screens.includes(selected.screen))) return failed('disconnected', 'That display is no longer connected. Refresh displays and choose an available monitor or projector.');
  const box = selected?.screen;
  const features = ['popup=yes', 'resizable=yes', 'scrollbars=no'];
  if (box) features.push(`left=${Math.round(box.availLeft)}`, `top=${Math.round(box.availTop)}`, `width=${Math.round(box.availWidth)}`, `height=${Math.round(box.availHeight)}`);
  const windowName = options.windowName && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(options.windowName) ? options.windowName : '_blank';
  try {
    const output = browser.open(target.href, windowName, features.join(','));
    if (!output) return failed('blocked', 'The output window was blocked. Allow pop-ups for this station, then select Open output again.');
    // Initial about:blank is synchronous, even when navigation follows. Do not
    // give a standalone output page a reference back to the operator's window.
    output.opener = null;
    output.focus();
    return { status: 'opened', window: output, placed: !!box, fullscreenRequired: true,
      message: box ? `Opened on ${display!.label}. Press F or use Fullscreen in the output window if needed.` : 'Output opened. Move its window to your monitor or projector, then press F for fullscreen.',
    };
  } catch { return failed('unavailable', 'The output window could not be opened. Allow pop-ups for this station, or open its link manually.'); }
}

/** Invoke on the receiving output page from its Fullscreen button/F shortcut.
 * Browsers decide whether the requesting document has sufficient user activation.
 * https://developer.mozilla.org/en-US/docs/Web/API/Element/requestFullscreen */
export async function requestDisplayFullscreen(element: HTMLElement, display: ConnectedDisplay | null = null): Promise<{ entered: boolean; message: string }> {
  if (!element.requestFullscreen) return { entered: false, message: 'Use your browser’s fullscreen command for this output window.' };
  const selected = display ? screens.get(display) : undefined;
  const options: FullscreenOptions & { screen?: DetailedDisplay } = { navigationUI: 'hide' };
  if (selected?.details.screens.includes(selected.screen)) options.screen = selected.screen;
  try { await element.requestFullscreen(options); return { entered: true, message: '' }; }
  catch { return { entered: false, message: 'Select Fullscreen or press F in the output window. The browser requires a click or key press to enter fullscreen.' }; }
}
