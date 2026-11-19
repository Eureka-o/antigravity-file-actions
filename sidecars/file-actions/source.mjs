import { TEXT_EXTENSIONS } from './actions.mjs';
import { MESSAGES, normalizeLanguage } from './i18n.mjs';

export function extractFilePath({ attributes = [], href = '', text = '', signature = '' } = {}) {
  const cleanPath = value => {
    if (typeof value !== 'string') return '';
    let candidate = value.trim();
    if (!candidate) return '';
    if (candidate.startsWith('file:')) {
      try {
        const url = new URL(candidate);
        if (url.protocol !== 'file:') return '';
        const pathname = decodeURIComponent(url.pathname).replaceAll('/', '\\');
        candidate = url.hostname && url.hostname !== 'localhost'
          ? `\\\\${url.hostname}${pathname}`
          : /^\\[A-Za-z]:/.test(pathname) ? pathname.slice(1) : pathname;
      } catch {
        return '';
      }
    }
    if (!/^(?:[A-Za-z]:[\\/]|\\\\)/.test(candidate) || /[\0\r\n"]/.test(candidate)) return '';
    return candidate.replace(/[),.;:]+$/, '');
  };

  const path = attributes.map(cleanPath).find(Boolean) || cleanPath(href);
  if (path) return path;
  if (!/file|artifact|attachment|output|download/i.test(signature)) return '';
  const match = String(text || '').match(/(?:[A-Za-z]:[\\/][^<>"\r\n]+|\\\\[^<>"\r\n]+)/);
  return cleanPath(match?.[0] || '');
}

function installFileActions(binding, extractPath, textExts, messages, normalizeLang, initialLang) {
  window.__agyFileActionsDispose?.();

  const styleId = 'agy-file-actions-style';
  const menuId = 'agy-file-actions-menu';
  const submenuId = 'agy-file-actions-submenu';
  const toastId = 'agy-file-actions-toast';
  const textExtSet = new Set(textExts);

  let active = null;
  let menu = null;
  let submenu = null;
  let toast = null;
  let toastTimer = 0;
  let submenuCloseTimer = 0;
  let activeElement = null;
  let lastContextTarget = null;
  let submenuTrigger = null;
  let currentLanguage = 'en';

  const resolveLanguage = () => {
    const override = normalizeLang(window.__agyFileActionsLang);
    if (override) return override;
    const provided = normalizeLang(initialLang);
    if (provided) return provided;
    const candidates = [];
    if (typeof navigator !== 'undefined' && navigator) {
      if (Array.isArray(navigator.languages)) candidates.push(...navigator.languages);
      if (navigator.language) candidates.push(navigator.language);
    }
    try {
      candidates.push(Intl.DateTimeFormat().resolvedOptions().locale);
    } catch {}
    for (const candidate of candidates) {
      const lang = normalizeLang(candidate);
      if (lang) return lang;
    }
    return 'en';
  };

  const applyLanguage = language => {
    currentLanguage = normalizeLang(language) === 'zh' ? 'zh' : 'en';
    const t = messages[currentLanguage] || messages.en;
    const htmlLang = currentLanguage === 'zh' ? 'zh-CN' : 'en';
    if (menu) {
      menu.lang = htmlLang;
      menu.setAttribute('aria-label', t.menuLabel);
      const labels = {
        reveal: t.reveal,
        'open-file': t.openFile,
        'open-default': t.openDefault,
        'open-with-menu': t.openWith,
        'save-as': t.saveAs,
        'copy-path': t.copyPath,
        'copy-content': t.copyContent,
      };
      for (const [action, label] of Object.entries(labels)) {
        const el = menu.querySelector(`[data-action="${action}"] .agy-action-label`);
        if (el) el.textContent = label;
      }
      if (active) {
        const contentAction = menu.querySelector('[data-action="copy-content"]');
        if (contentAction) {
          contentAction.title = contentAction.disabled ? t.copyContentDisabledTitle : t.copyContentEnabledTitle;
        }
      }
    }
    if (submenu) {
      submenu.lang = htmlLang;
      submenu.setAttribute('aria-label', t.submenuLabel);
      const chooseEl = submenu.querySelector('[data-action="open-with"] .agy-action-label');
      if (chooseEl) chooseEl.textContent = t.chooseApp;
    }
    if (toast) toast.lang = htmlLang;
    return t;
  };

  const ensureStyle = () => {
    let style = document.getElementById(styleId);
    if (style) return style;
    style = document.createElement('style');
    style.id = styleId;
    style.textContent = `
      #${menuId}, #${submenuId}, #${toastId} {
        --agy-fa-surface: var(--glass, var(--card, rgba(255, 255, 255, 0.94)));
        --agy-fa-fg: var(--foreground, #18191d);
        --agy-fa-muted: var(--muted-foreground, #686b75);
        --agy-fa-hover: var(--secondary, rgba(10, 10, 12, 0.06));
        --agy-fa-border: var(--glass-border, var(--border, rgba(10, 10, 12, 0.09)));
        --agy-fa-highlight: var(--glass-highlight, rgba(255, 255, 255, 0.7));
        --agy-fa-shadow: var(--glass-shadow, 0 14px 34px -10px rgba(10, 10, 12, 0.14), 0 2px 8px -1px rgba(10, 10, 12, 0.06));
        --agy-fa-sep: var(--border, rgba(10, 10, 12, 0.08));
        --agy-fa-ring: var(--nux-focus-ring, color-mix(in srgb, var(--primary, #2F71E3) 55%, transparent));
        --agy-fa-font: var(--font-sans, "Google Sans Flex", "Google Sans", system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
        --agy-fa-mono: var(--font-mono, ui-monospace, "Cascadia Mono", "Consolas", monospace);
        position: fixed;
        z-index: 2147483647;
        box-sizing: border-box;
        background-color: var(--agy-fa-surface);
        color: var(--agy-fa-fg);
        font-family: var(--agy-fa-font);
        border: 1px solid var(--agy-fa-border);
        backdrop-filter: blur(20px) saturate(1.6);
        -webkit-backdrop-filter: blur(20px) saturate(1.6);
        box-shadow: inset 0 1px 0 var(--agy-fa-highlight), var(--agy-fa-shadow);
      }
      #${menuId}, #${submenuId} {
        padding: 5px;
        border-radius: var(--nux-radius-md, 12px);
        font-size: 13px;
        line-height: 1.35;
        user-select: none;
        transform-origin: top left;
      }
      body:is(.dark, .dark-theme, .theme-dark) #${menuId},
      body:is(.dark, .dark-theme, .theme-dark) #${submenuId},
      body:is(.dark, .dark-theme, .theme-dark) #${toastId},
      :root[data-color-mode="dark"] #${menuId},
      :root[data-color-mode="dark"] #${submenuId},
      :root[data-color-mode="dark"] #${toastId} {
        --agy-fa-surface: var(--glass, var(--card, rgba(19, 19, 23, 0.94)));
        --agy-fa-fg: var(--foreground, #ffffff);
        --agy-fa-muted: var(--muted-foreground, #87888f);
        --agy-fa-hover: var(--secondary, rgba(255, 255, 255, 0.08));
        --agy-fa-border: var(--glass-border, var(--border, rgba(255, 255, 255, 0.09)));
        --agy-fa-highlight: var(--glass-highlight, rgba(255, 255, 255, 0.085));
        --agy-fa-shadow: var(--glass-shadow, 0 20px 44px -12px rgba(0, 0, 0, 0.55), 0 3px 10px -2px rgba(0, 0, 0, 0.35));
        --agy-fa-sep: var(--border, rgba(255, 255, 255, 0.07));
      }
      @media (prefers-color-scheme: dark) {
        body:not([data-agy-theme]):not(:is(.light, .light-theme, .theme-light)) #${menuId},
        body:not([data-agy-theme]):not(:is(.light, .light-theme, .theme-light)) #${submenuId},
        body:not([data-agy-theme]):not(:is(.light, .light-theme, .theme-light)) #${toastId} {
          --agy-fa-surface: var(--glass, var(--card, rgba(19, 19, 23, 0.94)));
          --agy-fa-fg: var(--foreground, #ffffff);
          --agy-fa-muted: var(--muted-foreground, #87888f);
          --agy-fa-hover: var(--secondary, rgba(255, 255, 255, 0.08));
          --agy-fa-border: var(--glass-border, var(--border, rgba(255, 255, 255, 0.09)));
          --agy-fa-highlight: var(--glass-highlight, rgba(255, 255, 255, 0.085));
          --agy-fa-shadow: var(--glass-shadow, 0 20px 44px -12px rgba(0, 0, 0, 0.55), 0 3px 10px -2px rgba(0, 0, 0, 0.35));
          --agy-fa-sep: var(--border, rgba(255, 255, 255, 0.07));
        }
      }
      #${menuId}[hidden], #${submenuId}[hidden] {
        display: none !important;
      }
      #${menuId} {
        min-width: 232px;
        max-width: 284px;
      }
      #${submenuId} {
        min-width: 196px;
        max-width: 256px;
      }
      @keyframes agyFaPop {
        from { opacity: 0; transform: scale(0.97) translateY(-2px); }
        to { opacity: 1; transform: scale(1) translateY(0); }
      }
      @keyframes agyFaToastIn {
        from { opacity: 0; transform: translateX(-50%) scale(0.97) translateY(3px); }
        to { opacity: 1; transform: translateX(-50%) scale(1) translateY(0); }
      }
      @media (prefers-reduced-motion: no-preference) {
        #${menuId}.agy-fa-open, #${submenuId}.agy-fa-open {
          animation: agyFaPop 130ms var(--ease-expo-out, cubic-bezier(0.16, 1, 0.3, 1));
        }
        #${toastId}:not([hidden]) {
          animation: agyFaToastIn 140ms var(--ease-expo-out, cubic-bezier(0.16, 1, 0.3, 1));
        }
      }
      #${menuId} .agy-fa-head {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 4px 8px 6px;
        color: var(--agy-fa-muted);
        font-size: 11.5px;
        font-weight: 500;
        border-bottom: 1px solid var(--agy-fa-sep);
        margin-bottom: 4px;
      }
      #${menuId} .agy-fa-head-name {
        flex: 1 1 auto;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        color: var(--agy-fa-fg);
        opacity: 0.88;
      }
      #${menuId} .agy-fa-head-ext {
        flex: 0 0 auto;
        font-family: var(--agy-fa-mono);
        font-size: 10px;
        letter-spacing: 0.03em;
        text-transform: uppercase;
        padding: 1px 5px;
        border-radius: 5px;
        background: var(--agy-fa-hover);
        color: var(--agy-fa-muted);
      }
      #${menuId} [role="menuitem"],
      #${submenuId} [role="menuitem"] {
        display: flex;
        align-items: center;
        gap: 9px;
        width: 100%;
        height: 31px;
        padding: 0 9px;
        border: 0;
        border-radius: 7px;
        background: transparent;
        color: var(--agy-fa-fg);
        font: inherit;
        font-weight: 450;
        text-align: left;
        white-space: nowrap;
        cursor: pointer;
        transition: background-color 110ms var(--ease-cubic-out, ease), color 110ms var(--ease-cubic-out, ease);
      }
      #${menuId} [role="menuitem"]:not(:disabled):hover,
      #${submenuId} [role="menuitem"]:not(:disabled):hover,
      #${menuId} [role="menuitem"][aria-expanded="true"] {
        background: var(--agy-fa-hover);
      }
      #${menuId} [role="menuitem"]:focus-visible,
      #${submenuId} [role="menuitem"]:focus-visible {
        outline: 2px solid var(--agy-fa-ring);
        outline-offset: -2px;
        background: var(--agy-fa-hover);
      }
      #${menuId} [role="menuitem"]:disabled {
        opacity: 0.42;
        cursor: not-allowed;
      }
      #${menuId} .agy-action-icon,
      #${submenuId} .agy-action-icon {
        display: inline-grid;
        place-items: center;
        width: 16px;
        height: 16px;
        flex: 0 0 16px;
        color: var(--agy-fa-muted);
        transition: color 110ms var(--ease-cubic-out, ease);
      }
      #${menuId} [role="menuitem"]:not(:disabled):hover .agy-action-icon,
      #${submenuId} [role="menuitem"]:not(:disabled):hover .agy-action-icon,
      #${menuId} [role="menuitem"][aria-expanded="true"] .agy-action-icon {
        color: var(--agy-fa-fg);
      }
      #${menuId} .agy-action-icon svg,
      #${submenuId} .agy-action-icon svg {
        display: block;
        width: 15px;
        height: 15px;
        fill: none;
        stroke: currentColor;
        stroke-width: 1.55;
        stroke-linecap: round;
        stroke-linejoin: round;
      }
      #${menuId} .agy-action-label,
      #${submenuId} .agy-action-label {
        flex: 1 1 auto;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      #${menuId} .agy-action-chevron {
        margin-left: auto;
        flex: 0 0 auto;
        color: var(--agy-fa-muted);
        font-size: 14px;
        line-height: 1;
      }
      #${menuId} [role="separator"] {
        height: 1px;
        margin: 4px 6px;
        background: var(--agy-fa-sep);
      }
      #${toastId} {
        left: 50%;
        bottom: 22px;
        transform: translateX(-50%);
        padding: 6px 12px;
        border-radius: var(--nux-radius-pill, 9999px);
        font-size: 12px;
        font-weight: 500;
        pointer-events: none;
      }
      #${toastId}[hidden] {
        display: none !important;
      }
    `;
    (document.head || document.documentElement).appendChild(style);
    return style;
  };

  const showToast = text => {
    ensureStyle();
    if (!toast) {
      toast = document.createElement('div');
      toast.id = toastId;
      toast.setAttribute('role', 'status');
      document.body.appendChild(toast);
    }
    toast.lang = (currentLanguage || resolveLanguage()) === 'zh' ? 'zh-CN' : 'en';
    toast.style.colorScheme = detectColorScheme();
    toast.textContent = text;
    toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => {
      if (toast) toast.hidden = true;
    }, 1500);
  };

  const detectColorScheme = () => {
    const body = document.body;
    if (body?.classList.contains('dark') || body?.classList.contains('dark-theme') || body?.classList.contains('theme-dark')) {
      return 'dark';
    }
    if (body?.classList.contains('light') || body?.classList.contains('light-theme') || body?.classList.contains('theme-light') || body?.hasAttribute('data-agy-theme')) {
      return 'light';
    }
    return getComputedStyle(document.documentElement).colorScheme || 'light dark';
  };

  const pathFromElement = element => {
    let current = element instanceof Element ? element : element?.parentElement ?? null;
    for (let depth = 0; current && depth < 8; depth += 1, current = current.parentElement) {
      const signature = [
        current.tagName,
        current.getAttribute('role'),
        current.getAttribute('data-testid'),
        current.getAttribute('aria-label'),
        String(current.className || ''),
      ].join(' ');
      const attributes = ['data-path', 'data-filepath', 'data-file-path', 'data-uri', 'data-file-uri', 'data-resource-uri', 'data-filename']
        .map(attribute => current.getAttribute(attribute));
      const path = extractPath({ attributes, href: current.getAttribute('href'), text: current.textContent, signature })
        || extractPath({ attributes: [current.getAttribute('title')] });
      if (path) return path;
    }
    return '';
  };

  const icon = name => ({
    open: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2.25" y="2.75" width="11.5" height="10.5" rx="2"/><path d="M9.75 2.75v10.5"/><path d="M4.75 6h2.75M4.75 8.5h2.75"/></svg>',
    default: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6.5 3.5H4a1.5 1.5 0 0 0-1.5 1.5v7A1.5 1.5 0 0 0 4 13.5h7a1.5 1.5 0 0 0 1.5-1.5V9.5"/><path d="M9.5 2.5h4v4"/><path d="M13.5 2.5 8 8"/></svg>',
    with: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2.5" y="2.5" width="4.5" height="4.5" rx="1"/><rect x="9" y="2.5" width="4.5" height="4.5" rx="1"/><rect x="2.5" y="9" width="4.5" height="4.5" rx="1"/><rect x="9" y="9" width="4.5" height="4.5" rx="1"/></svg>',
    choose: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 4.5h10M3 8h10M3 11.5h6"/><path d="m11.25 10 2 1.75-2 1.75"/></svg>',
    reveal: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.25 5.25V12a1.5 1.5 0 0 0 1.5 1.5h8.5a1.5 1.5 0 0 0 1.5-1.5V6.5a1.5 1.5 0 0 0-1.5-1.5H7.8L6.4 3.4a1 1 0 0 0-.75-.35H3.75a1.5 1.5 0 0 0-1.5 1.5Z"/></svg>',
    save: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.5v7.25"/><path d="m5.25 7.25 2.75 2.75 2.75-2.75"/><path d="M3 11.75v.75A1.25 1.25 0 0 0 4.25 13.75h7.5A1.25 1.25 0 0 0 13 12.5v-.75"/></svg>',
    path: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6.25 9.75 9.75 6.25"/><path d="M7.5 4.75 8.8 3.45a2.4 2.4 0 0 1 3.4 3.4l-1.3 1.3"/><path d="M8.5 11.25 7.2 12.55a2.4 2.4 0 0 1-3.4-3.4l1.3-1.3"/></svg>',
    content: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="5" y="4.5" width="8.25" height="9.25" rx="1.5"/><path d="M3.25 10.75a1.25 1.25 0 0 1-.75-1.15V3.75A1.5 1.5 0 0 1 4 2.25h5.6c.45 0 .85.22 1.1.55"/></svg>',
  }[name]);

  const cancelSubmenuClose = () => {
    clearTimeout(submenuCloseTimer);
    submenuCloseTimer = 0;
  };

  const scheduleSubmenuClose = () => {
    cancelSubmenuClose();
    submenuCloseTimer = window.setTimeout(() => hideSubmenu(), 140);
  };

  const handleActionClick = button => {
    if (!active || button.disabled) return;
    const action = button.dataset.action;
    if (action === 'open-with-menu') {
      showSubmenu();
      return;
    }
    if (action === 'open-file' && activeElement?.isConnected) {
      activeElement.click();
      hideMenu();
      return;
    }
    const mappedAction = action === 'open-file' ? 'open-default' : action;
    const lang = currentLanguage || resolveLanguage();
    const t = messages[lang] || messages.en;
    const payload = JSON.stringify({ action: mappedAction, path: active, language: lang });
    try { window[binding](payload); } catch {}
    if (mappedAction === 'copy-path') showToast(t.toastPathCopied);
    else if (mappedAction === 'copy-content') showToast(t.toastContentCopied);
    hideMenu();
  };

  const bindMenuButtons = container => {
    for (const button of container.querySelectorAll('[role="menuitem"]')) {
      button.addEventListener('pointerenter', () => {
        if (button.dataset.action === 'open-with-menu') {
          cancelSubmenuClose();
          showSubmenu();
        } else if (container === menu && submenu && !submenu.hidden) {
          scheduleSubmenuClose();
        }
      });
      button.addEventListener('click', event => {
        event.stopPropagation();
        handleActionClick(button);
      });
    }
  };

  const handleMenuKeyDown = event => {
    const owner = event.target.closest('[role="menu"]');
    if (!owner) return;
    const items = [...owner.querySelectorAll('[role="menuitem"]:not(:disabled)')];
    if (!items.length) return;
    const current = items.indexOf(document.activeElement);
    if (event.key === 'Escape') {
      event.preventDefault();
      if (owner === submenu) {
        hideSubmenu();
        submenuTrigger?.focus();
      } else {
        hideMenu(true);
      }
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      const base = current < 0 ? (step > 0 ? -1 : 0) : current;
      const next = (base + step + items.length) % items.length;
      items[next].focus();
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      items[event.key === 'Home' ? 0 : items.length - 1].focus();
    } else if (event.key === 'ArrowRight' && document.activeElement === submenuTrigger) {
      event.preventDefault();
      showSubmenu();
      submenu?.querySelector('[role="menuitem"]:not(:disabled)')?.focus();
    } else if (event.key === 'ArrowLeft' && owner === submenu) {
      event.preventDefault();
      hideSubmenu();
      submenuTrigger?.focus();
    }
  };

  const ensureMenu = () => {
    ensureStyle();
    if (menu && submenu) return menu;

    menu = document.createElement('div');
    menu.id = menuId;
    menu.hidden = true;
    menu.setAttribute('role', 'menu');
    menu.innerHTML = `
      <div class="agy-fa-head" role="none">
        <span class="agy-fa-head-name"></span>
        <span class="agy-fa-head-ext" hidden></span>
      </div>
      <button type="button" role="menuitem" data-action="reveal"><span class="agy-action-icon">${icon('reveal')}</span><span class="agy-action-label"></span></button>
      <button type="button" role="menuitem" data-action="open-file"><span class="agy-action-icon">${icon('open')}</span><span class="agy-action-label"></span></button>
      <button type="button" role="menuitem" data-action="open-default"><span class="agy-action-icon">${icon('default')}</span><span class="agy-action-label"></span></button>
      <button type="button" role="menuitem" data-action="open-with-menu" aria-haspopup="menu" aria-expanded="false"><span class="agy-action-icon">${icon('with')}</span><span class="agy-action-label"></span><span class="agy-action-chevron" aria-hidden="true">›</span></button>
      <div role="separator"></div>
      <button type="button" role="menuitem" data-action="save-as"><span class="agy-action-icon">${icon('save')}</span><span class="agy-action-label"></span></button>
      <button type="button" role="menuitem" data-action="copy-path"><span class="agy-action-icon">${icon('path')}</span><span class="agy-action-label"></span></button>
      <button type="button" role="menuitem" data-action="copy-content"><span class="agy-action-icon">${icon('content')}</span><span class="agy-action-label"></span></button>
    `;

    // Append submenu directly to document.body so menu's backdrop-filter never
    // creates a containing block that offsets submenu's position: fixed coordinates.
    submenu = document.createElement('div');
    submenu.id = submenuId;
    submenu.hidden = true;
    submenu.setAttribute('role', 'menu');
    submenu.innerHTML = `
      <button type="button" role="menuitem" data-action="open-with"><span class="agy-action-icon">${icon('choose')}</span><span class="agy-action-label"></span></button>
    `;

    applyLanguage(resolveLanguage());

    bindMenuButtons(menu);
    bindMenuButtons(submenu);

    menu.addEventListener('keydown', handleMenuKeyDown);
    submenu.addEventListener('keydown', handleMenuKeyDown);
    submenu.addEventListener('pointerenter', cancelSubmenuClose);
    submenu.addEventListener('pointerleave', scheduleSubmenuClose);
    menu.addEventListener('pointerdown', event => {
      if (!submenuTrigger?.contains(event.target)) hideSubmenu();
    });

    document.body.append(menu, submenu);
    return menu;
  };

  const isTextPath = path => {
    const base = String(path || '').split(/[\\/]/).pop() || '';
    const dot = base.lastIndexOf('.');
    return dot > 0 && textExtSet.has(base.slice(dot + 1).toLowerCase());
  };

  const showSubmenu = () => {
    if (!menu || !submenu) return;
    cancelSubmenuClose();
    submenuTrigger ||= menu.querySelector('[data-action="open-with-menu"]');
    if (!submenuTrigger) return;
    const rect = submenuTrigger.getBoundingClientRect();
    submenu.style.colorScheme = menu.style.colorScheme;
    submenu.classList.remove('agy-fa-open');
    submenu.style.left = '0px';
    submenu.style.top = '0px';
    submenu.hidden = false;
    submenuTrigger.setAttribute('aria-expanded', 'true');
    const size = submenu.getBoundingClientRect();
    const left = rect.right + size.width <= window.innerWidth - 8
      ? rect.right - 2
      : rect.left - size.width + 2;
    submenu.style.left = `${Math.max(6, Math.min(left, window.innerWidth - size.width - 8))}px`;
    submenu.style.top = `${Math.max(6, Math.min(rect.top - 5, window.innerHeight - size.height - 8))}px`;
    submenu.classList.add('agy-fa-open');
  };

  const hideSubmenu = () => {
    cancelSubmenuClose();
    if (submenu) {
      submenu.hidden = true;
      submenu.classList.remove('agy-fa-open');
    }
    menu?.querySelector('[data-action="open-with-menu"]')?.setAttribute('aria-expanded', 'false');
  };

  const hideMenu = (restoreFocus = false) => {
    if (!menu) return;
    hideSubmenu();
    menu.hidden = true;
    menu.classList.remove('agy-fa-open');
    active = null;
    activeElement = null;
    if (restoreFocus) lastContextTarget?.focus?.({ preventScroll: true });
  };

  const showMenu = (event, path) => {
    const target = ensureMenu();
    submenuTrigger = target.querySelector('[data-action="open-with-menu"]');
    active = path;

    const t = applyLanguage(resolveLanguage());
    const scheme = detectColorScheme();
    target.style.colorScheme = scheme;

    const baseName = path.split(/[\\/]/).filter(Boolean).pop() || path;
    const dot = baseName.lastIndexOf('.');
    const ext = dot > 0 ? baseName.slice(dot + 1).slice(0, 8) : '';
    const head = target.querySelector('.agy-fa-head');
    const nameEl = target.querySelector('.agy-fa-head-name');
    const extEl = target.querySelector('.agy-fa-head-ext');
    if (head) head.title = path;
    if (nameEl) nameEl.textContent = baseName;
    if (extEl) {
      extEl.hidden = !ext;
      extEl.textContent = ext;
    }

    const contentAction = target.querySelector('[data-action="copy-content"]');
    if (contentAction) {
      contentAction.disabled = !isTextPath(path);
      contentAction.title = contentAction.disabled
        ? t.copyContentDisabledTitle
        : t.copyContentEnabledTitle;
    }

    const targetEl = event.target instanceof Element ? event.target : event.target?.parentElement ?? null;
    activeElement = targetEl ? targetEl.closest('a,button,[role="button"]') : null;
    lastContextTarget = activeElement || targetEl;

    hideSubmenu();
    target.classList.remove('agy-fa-open');
    target.hidden = false;
    target.style.left = '0px';
    target.style.top = '0px';
    const rect = target.getBoundingClientRect();
    target.style.left = `${Math.max(6, Math.min(event.clientX, window.innerWidth - rect.width - 8))}px`;
    target.style.top = `${Math.max(6, Math.min(event.clientY, window.innerHeight - rect.height - 8))}px`;
    target.classList.add('agy-fa-open');
    target.querySelector('[role="menuitem"]')?.focus({ preventScroll: true });
  };

  const onContextMenu = event => {
    const path = pathFromElement(event.target);
    if (!path) return;
    event.preventDefault();
    event.stopPropagation();
    showMenu(event, path);
  };
  const onPointerDown = event => {
    if (!menu || menu.hidden) return;
    if (!menu.contains(event.target) && !submenu?.contains(event.target)) hideMenu();
  };
  const onKeyDown = event => {
    if (event.key === 'Escape' && menu && !menu.hidden) hideMenu(true);
  };
  const onLanguageChange = () => {
    applyLanguage(resolveLanguage());
  };

  document.addEventListener('contextmenu', onContextMenu, true);
  document.addEventListener('pointerdown', onPointerDown, true);
  document.addEventListener('keydown', onKeyDown, true);
  window.addEventListener?.('languagechange', onLanguageChange);

  window.__agyFileActionsDispose = () => {
    cancelSubmenuClose();
    clearTimeout(toastTimer);
    document.removeEventListener('contextmenu', onContextMenu, true);
    document.removeEventListener('pointerdown', onPointerDown, true);
    document.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener?.('languagechange', onLanguageChange);
    menu?.remove();
    submenu?.remove();
    toast?.remove();
    document.getElementById(styleId)?.remove();
    menu = null;
    submenu = null;
    toast = null;
    active = null;
    activeElement = null;
    lastContextTarget = null;
    submenuTrigger = null;
  };
}

export function makeRendererSource(binding, { language = '' } = {}) {
  return `(${installFileActions.toString()})(${JSON.stringify(binding)},(${extractFilePath.toString()}),${JSON.stringify([...TEXT_EXTENSIONS])},${JSON.stringify(MESSAGES)},(${normalizeLanguage.toString()}),${JSON.stringify(language)});`;
}
