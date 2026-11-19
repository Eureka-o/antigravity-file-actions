import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractFilePath, makeRendererSource } from '../sidecars/file-actions/source.mjs';
import { buildActionSpec, inspectTarget, runAction, safePath } from '../sidecars/file-actions/actions.mjs';
import {
  MESSAGES,
  detectSystemLanguage,
  normalizeLanguage,
  parseRegQueryLocale,
} from '../sidecars/file-actions/i18n.mjs';

function decodeEncodedCommand(args) {
  const index = args.indexOf('-EncodedCommand');
  assert.notEqual(index, -1);
  return Buffer.from(args[index + 1], 'base64').toString('utf16le');
}

function createMockDom({ navigator = {}, intlLocale = 'en-US' } = {}) {
  const docListeners = new Map();
  const winListeners = new Map();
  let nextTimerId = 1;

  const toDatasetKey = attr => attr.slice(5).replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());

  class MockElement {
    constructor(tagName) {
      this.tagName = String(tagName || 'DIV').toUpperCase();
      this.attributes = new Map();
      this.dataset = {};
      this.children = [];
      this.parentElement = null;
      this.style = {};
      this.hidden = false;
      this.disabled = false;
      this.title = '';
      this.lang = '';
      this._id = '';
      this._className = '';
      this._textContent = '';
      this._listeners = new Map();
      this.isConnected = true;
      this.classList = {
        contains: cls => this._className.split(/\s+/).filter(Boolean).includes(cls),
        add: cls => {
          const set = new Set(this._className.split(/\s+/).filter(Boolean));
          set.add(cls);
          this._className = [...set].join(' ');
        },
        remove: cls => {
          const list = this._className.split(/\s+/).filter(Boolean).filter(c => c !== cls);
          this._className = list.join(' ');
        },
      };
    }

    get id() { return this._id; }
    set id(val) { this._id = String(val); this.attributes.set('id', this._id); }

    get className() { return this._className; }
    set className(val) { this._className = String(val); this.attributes.set('class', this._className); }

    get textContent() {
      return this.children.length
        ? this.children.map(child => child.textContent).join('')
        : this._textContent;
    }
    set textContent(val) {
      this.children = [];
      this._textContent = String(val ?? '');
    }

    set innerHTML(html) {
      this.children = [];
      this._textContent = '';
      const stack = [this];
      const tokenRe = /<(\/?)([a-zA-Z0-9-]+)([^>]*?)(\/?)>/g;
      let match;
      while ((match = tokenRe.exec(String(html))) !== null) {
        const [, closing, tag, rawAttrs, selfClosing] = match;
        if (closing) {
          if (stack.length > 1) stack.pop();
          continue;
        }
        const el = new MockElement(tag);
        const attrRe = /([a-zA-Z0-9:-]+)(?:="([^"]*)")?/g;
        let attrMatch;
        while ((attrMatch = attrRe.exec(rawAttrs)) !== null) {
          const [, name, value = ''] = attrMatch;
          el.setAttribute(name, value);
        }
        stack.at(-1).appendChild(el);
        if (!selfClosing) stack.push(el);
      }
    }

    setAttribute(name, value) {
      const str = String(value);
      this.attributes.set(name, str);
      if (name === 'id') this._id = str;
      else if (name === 'class') this._className = str;
      else if (name === 'hidden') this.hidden = true;
      else if (name === 'disabled') this.disabled = true;
      else if (name.startsWith('data-')) this.dataset[toDatasetKey(name)] = str;
    }

    getAttribute(name) {
      return this.attributes.has(name) ? this.attributes.get(name) : null;
    }

    hasAttribute(name) {
      return this.attributes.has(name);
    }

    appendChild(child) {
      child.parentElement = this;
      this.children.push(child);
      return child;
    }

    append(...nodes) {
      for (const node of nodes) this.appendChild(node);
    }

    remove() {
      if (!this.parentElement) return;
      this.parentElement.children = this.parentElement.children.filter(c => c !== this);
      this.parentElement = null;
    }

    contains(node) {
      let cur = node;
      while (cur) {
        if (cur === this) return true;
        cur = cur.parentElement;
      }
      return false;
    }

    matchesSimple(part) {
      if (part.startsWith('.')) return this.classList.contains(part.slice(1));
      const attrMatch = part.match(/^\[([^=\]]+)(?:="([^"]*)")?\]$/);
      if (attrMatch) {
        const [, attr, expected] = attrMatch;
        const actual = this.getAttribute(attr);
        return expected === undefined ? actual !== null : actual === expected;
      }
      return this.tagName === part.toUpperCase();
    }

    matches(selector) {
      return selector.split(',').some(group => {
        const chain = group.trim().split(/\s+/);
        let cur = this;
        for (let i = chain.length - 1; i >= 0; i -= 1) {
          const token = chain[i];
          if (i === chain.length - 1) {
            if (!cur.matchesSimple(token)) return false;
          } else {
            cur = cur.parentElement;
            while (cur && !cur.matchesSimple(token)) cur = cur.parentElement;
            if (!cur) return false;
          }
        }
        return true;
      });
    }

    querySelectorAll(selector) {
      const results = [];
      const walk = node => {
        for (const child of node.children) {
          if (child.matches(selector)) results.push(child);
          walk(child);
        }
      };
      walk(this);
      return results;
    }

    querySelector(selector) {
      return this.querySelectorAll(selector)[0] || null;
    }

    closest(selector) {
      let cur = this;
      while (cur) {
        if (cur.matches(selector)) return cur;
        cur = cur.parentElement;
      }
      return null;
    }

    addEventListener(type, fn) {
      if (!this._listeners.has(type)) this._listeners.set(type, []);
      this._listeners.get(type).push(fn);
    }

    dispatchEvent(event) {
      event.target ??= this;
      for (const fn of this._listeners.get(event.type) || []) fn(event);
    }

    click() {
      this.dispatchEvent({ type: 'click', stopPropagation() {} });
    }

    focus() {
      document.activeElement = this;
    }

    getBoundingClientRect() {
      return { left: 0, top: 0, right: 240, bottom: 220, width: 240, height: 220 };
    }
  }

  const head = new MockElement('HEAD');
  const documentElement = new MockElement('HTML');
  const body = new MockElement('BODY');
  documentElement.append(head, body);

  const findById = (root, id) => {
    for (const child of root.children) {
      if (child.id === id) return child;
      const nested = findById(child, id);
      if (nested) return nested;
    }
    return null;
  };

  const document = {
    head,
    documentElement,
    body,
    activeElement: null,
    createElement: tag => new MockElement(tag),
    getElementById: id => findById(documentElement, id),
    addEventListener: (type, fn) => {
      if (!docListeners.has(type)) docListeners.set(type, new Set());
      docListeners.get(type).add(fn);
    },
    removeEventListener: (type, fn) => {
      docListeners.get(type)?.delete(fn);
    },
    dispatchEvent: event => {
      for (const fn of docListeners.get(event.type) || []) fn(event);
    },
  };

  const sandbox = {
    Element: MockElement,
    document,
    navigator,
    innerWidth: 1280,
    innerHeight: 800,
    getComputedStyle: () => ({ colorScheme: 'light' }),
    setTimeout: () => nextTimerId++,
    clearTimeout: () => {},
    addEventListener: (type, fn) => {
      if (!winListeners.has(type)) winListeners.set(type, new Set());
      winListeners.get(type).add(fn);
    },
    removeEventListener: (type, fn) => {
      winListeners.get(type)?.delete(fn);
    },
    dispatchWindowEvent: event => {
      for (const fn of winListeners.get(event.type) || []) fn(event);
    },
    Intl: {
      DateTimeFormat: () => ({
        resolvedOptions: () => ({ locale: intlLocale }),
      }),
    },
    docListeners,
    winListeners,
  };
  sandbox.window = sandbox;
  return sandbox;
}

test('renderer source installs only file-scoped context actions', () => {
  const source = makeRendererSource('agyFileActionsV1');
  assert.match(source, /contextmenu/);
  assert.match(source, /data-path/);
  assert.match(source, /在资源管理器中打开/);
  assert.match(source, /在侧边栏中打开/);
  assert.match(source, /在默认应用中打开/);
  assert.match(source, /Reveal in File Explorer/);
  assert.match(source, /Open in Sidebar/);
  assert.match(source, /Open in Default App/);
  assert.match(source, /navigator\.languages/);
  assert.match(source, /languagechange/);
  assert.match(source, /agyFileActionsV1/);
  assert.match(source, /--glass-border/);
  assert.match(source, /prefers-color-scheme:\s*dark/);
  assert.match(source, /agy-file-actions-submenu/);

  const pinnedSource = makeRendererSource('agyFileActionsV1', { language: 'en' });
  assert.match(pinnedSource, /"en"\);$/);
});

test('extractFilePath parses file URIs with fragments and UNC paths', () => {
  assert.equal(
    extractFilePath({ attributes: ['file:///c%3A/Users/19890/space%20dir/a.pdf#L0-16'] }),
    'c:\\Users\\19890\\space dir\\a.pdf'
  );
  assert.equal(
    extractFilePath({ attributes: ['\\\\server\\share\\folder\\test.txt'] }),
    '\\\\server\\share\\folder\\test.txt'
  );
  assert.equal(extractFilePath({ attributes: ['slashCommand:compact'] }), '');
});

test('safePath normalizes forward slashes and validates existence', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy file actions '));
  try {
    const file = join(dir, 'hello world.mjs');
    writeFileSync(file, 'console.log(1);\n', 'utf8');
    const forward = file.replaceAll('\\', '/');
    assert.equal(safePath(forward), file);
    assert.equal(safePath(file + '"'), '');
    assert.equal(safePath(join(dir, 'missing.txt')), '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('buildActionSpec constructs reliable Windows process specs for spaces and directories', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy spec '));
  try {
    const file = join(dir, 'report + 中文.mjs');
    const emptyFile = join(dir, 'empty.txt');
    writeFileSync(file, 'export default 1;\n', 'utf8');
    writeFileSync(emptyFile, '', 'utf8');

    const fileInfo = inspectTarget(file);
    const dirInfo = inspectTarget(dir);
    const emptyInfo = inspectTarget(emptyFile);

    const revealFile = buildActionSpec('reveal', fileInfo);
    assert.equal(revealFile.command, 'explorer.exe');
    assert.deepEqual(revealFile.args, [`/select,"${file}"`]);
    assert.equal(revealFile.options.windowsVerbatimArguments, true);
    assert.equal(revealFile.options.windowsHide, false);

    const revealDir = buildActionSpec('reveal', dirInfo);
    assert.equal(revealDir.command, 'explorer.exe');
    assert.deepEqual(revealDir.args, [`"${dir}"`]);
    assert.equal(revealDir.options.windowsVerbatimArguments, true);

    const openDefault = buildActionSpec('open-default', fileInfo);
    assert.equal(openDefault.command, 'powershell.exe');
    assert.equal(openDefault.options.detached, false);
    assert.equal(openDefault.options.windowsHide, true);

    const openWith = buildActionSpec('open-with', fileInfo);
    assert.equal(openWith.command, 'rundll32.exe');
    assert.deepEqual(openWith.args, [`shell32.dll,OpenAs_RunDLL ${file}`]);
    assert.equal(openWith.options.windowsVerbatimArguments, true);
    assert.equal(openWith.options.windowsHide, false);
    assert.equal(buildActionSpec('open-with', dirInfo), null);

    const saveAs = buildActionSpec('save-as', fileInfo);
    assert.equal(saveAs.command, 'powershell.exe');
    assert.equal(saveAs.options.detached, false);
    assert.equal(buildActionSpec('save-as', dirInfo), null);

    const saveAsZh = buildActionSpec('save-as', fileInfo, { language: 'zh' });
    assert.match(decodeEncodedCommand(saveAsZh.args), /所有文件 \(\*\.\*\)\|\*\.\*/);
    const saveAsEn = buildActionSpec('save-as', fileInfo, { language: 'en' });
    assert.match(decodeEncodedCommand(saveAsEn.args), /All files \(\*\.\*\)\|\*\.\*/);

    const copyPath = buildActionSpec('copy-path', fileInfo);
    assert.equal(copyPath.command, 'powershell.exe');
    assert.equal(copyPath.options.detached, false);

    const copyContent = buildActionSpec('copy-content', fileInfo);
    assert.equal(copyContent.command, 'powershell.exe');
    assert.equal(copyContent.options.detached, false);

    const copyEmpty = buildActionSpec('copy-content', emptyInfo);
    assert.equal(copyEmpty.command, 'powershell.exe');
    assert.equal(copyEmpty.options.detached, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runAction only unrefs detached child processes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy run '));
  try {
    const file = join(dir, 'note.md');
    writeFileSync(file, '# hi\n', 'utf8');
    const calls = [];
    const fakeSpawn = (command, args, options) => {
      const entry = { command, args, options, unreffed: false };
      calls.push(entry);
      return {
        on() {},
        unref() { entry.unreffed = true; },
      };
    };

    assert.equal(runAction('reveal', file, { spawnImpl: fakeSpawn, platform: 'win32' }), true);
    assert.equal(calls.at(-1).unreffed, true);

    assert.equal(runAction('copy-path', file, { spawnImpl: fakeSpawn, platform: 'win32' }), true);
    assert.equal(calls.at(-1).unreffed, false);
    assert.equal(calls.at(-1).options.detached, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('normalizeLanguage maps Chinese variants to zh, others to en, and neutral values to empty', () => {
  for (const tag of ['zh', 'zh-CN', 'zh_CN.UTF-8', 'zh-Hans-CN', 'zh-TW', 'zh-HK']) {
    assert.equal(normalizeLanguage(tag), 'zh', tag);
  }
  for (const tag of ['en', 'en-US', 'ja-JP', 'de-DE']) {
    assert.equal(normalizeLanguage(tag), 'en', tag);
  }
  for (const tag of ['', 'auto', 'C', 'POSIX', 'C.UTF-8', null, undefined]) {
    assert.equal(normalizeLanguage(tag), '', String(tag));
  }
});

test('parseRegQueryLocale parses REG_MULTI_SZ and REG_SZ outputs safely', () => {
  assert.equal(
    parseRegQueryLocale('\r\nHKEY_CURRENT_USER\\Control Panel\\Desktop\r\n    PreferredUILanguages    REG_MULTI_SZ    zh-CN\r\n', 'PreferredUILanguages'),
    'zh-CN'
  );
  assert.equal(
    parseRegQueryLocale('    PreferredUILanguages    REG_MULTI_SZ    en-US\\0zh-CN\r\n', 'PreferredUILanguages'),
    'en-US'
  );
  assert.equal(
    parseRegQueryLocale('    LocaleName    REG_SZ    zh-CN\r\n', 'LocaleName'),
    'zh-CN'
  );
  assert.equal(
    parseRegQueryLocale('    OtherKey    REG_SZ    zh-CN\r\n', 'LocaleName'),
    ''
  );
  assert.equal(parseRegQueryLocale('', 'LocaleName'), '');
});

test('detectSystemLanguage respects env overrides and Windows UI language precedence', async () => {
  assert.equal(
    await detectSystemLanguage({ env: { AGY_FILE_ACTIONS_LANG: 'en', LANG: 'zh_CN.UTF-8' }, platform: 'linux', intlLocale: 'zh-CN' }),
    'en'
  );
  assert.equal(
    await detectSystemLanguage({ env: { AGY_FILE_ACTIONS_LANG: 'zh' }, platform: 'linux', intlLocale: 'en-US' }),
    'zh'
  );
  assert.equal(
    await detectSystemLanguage({ env: { AGY_FILE_ACTIONS_LANG: 'auto', LC_ALL: 'C.UTF-8', LC_MESSAGES: 'zh_CN.UTF-8', LANG: 'en_US.UTF-8' }, platform: 'linux', intlLocale: 'en-US' }),
    'zh'
  );

  const mockExec = values => (_cmd, args, _opts, cb) => {
    const key = args[1];
    const valueName = args[3];
    const entry = values[`${key}\\${valueName}`];
    if (entry instanceof Error) { cb(entry, ''); return; }
    cb(null, entry || '');
  };

  // English Windows UI + Chinese regional format -> English
  assert.equal(
    await detectSystemLanguage({
      env: {},
      platform: 'win32',
      intlLocale: 'zh-CN',
      execFileImpl: mockExec({
        'HKCU\\Control Panel\\Desktop\\PreferredUILanguages': '    PreferredUILanguages    REG_MULTI_SZ    en-US\\0zh-CN\r\n',
        'HKCU\\Control Panel\\International\\LocaleName': '    LocaleName    REG_SZ    zh-CN\r\n',
      }),
    }),
    'en'
  );

  // Chinese Windows UI + English regional format -> Chinese
  assert.equal(
    await detectSystemLanguage({
      env: {},
      platform: 'win32',
      intlLocale: 'en-US',
      execFileImpl: mockExec({
        'HKCU\\Control Panel\\Desktop\\PreferredUILanguages': '    PreferredUILanguages    REG_MULTI_SZ    zh-CN\r\n',
        'HKCU\\Control Panel\\International\\LocaleName': '    LocaleName    REG_SZ    en-US\r\n',
      }),
    }),
    'zh'
  );

  // Fallback chain when earlier keys error or return empty
  assert.equal(
    await detectSystemLanguage({
      env: {},
      platform: 'win32',
      intlLocale: 'en-US',
      execFileImpl: mockExec({
        'HKCU\\Control Panel\\Desktop\\PreferredUILanguages': new Error('missing'),
        'HKCU\\Control Panel\\Desktop\\MuiCached\\MachinePreferredUILanguages': '',
        'HKCU\\Control Panel\\International\\LocaleName': '    LocaleName    REG_SZ    zh-CN\r\n',
      }),
    }),
    'zh'
  );

  // Non-Chinese locale falls back to en
  assert.equal(
    await detectSystemLanguage({
      env: {},
      platform: 'win32',
      intlLocale: 'ja-JP',
      execFileImpl: mockExec({
        'HKCU\\Control Panel\\Desktop\\PreferredUILanguages': '    PreferredUILanguages    REG_MULTI_SZ    ja-JP\r\n',
      }),
    }),
    'en'
  );
});

test('renderer auto-detects language, respects overrides, and cleans up listeners', () => {
  const triggerContextMenu = (sandbox, path) => {
    const target = sandbox.document.createElement('a');
    target.setAttribute('data-path', path);
    sandbox.document.body.appendChild(target);
    sandbox.document.dispatchEvent({
      type: 'contextmenu',
      target,
      clientX: 40,
      clientY: 60,
      preventDefault() {},
      stopPropagation() {},
    });
    return {
      menu: sandbox.document.getElementById('agy-file-actions-menu'),
      submenu: sandbox.document.getElementById('agy-file-actions-submenu'),
    };
  };

  // 1. English navigator auto-detection
  {
    const payloads = [];
    const sandbox = createMockDom({ navigator: { language: 'en-US', languages: ['en-US'] }, intlLocale: 'en-US' });
    sandbox.agyFileActionsV1 = payload => payloads.push(JSON.parse(payload));
    vm.runInNewContext(makeRendererSource('agyFileActionsV1'), sandbox);

    const { menu, submenu } = triggerContextMenu(sandbox, 'C:\\temp\\report.pdf');
    assert.equal(menu.lang, 'en');
    assert.equal(menu.getAttribute('aria-label'), MESSAGES.en.menuLabel);
    assert.equal(menu.querySelector('[data-action="reveal"] .agy-action-label').textContent, MESSAGES.en.reveal);
    assert.equal(menu.querySelector('[data-action="copy-content"]').disabled, true);
    assert.equal(menu.querySelector('[data-action="copy-content"]').title, MESSAGES.en.copyContentDisabledTitle);
    assert.equal(submenu.getAttribute('aria-label'), MESSAGES.en.submenuLabel);
    assert.equal(submenu.querySelector('[data-action="open-with"] .agy-action-label').textContent, MESSAGES.en.chooseApp);

    menu.querySelector('[data-action="copy-path"]').click();
    assert.equal(sandbox.document.getElementById('agy-file-actions-toast').textContent, MESSAGES.en.toastPathCopied);
    assert.deepEqual(payloads, [{ action: 'copy-path', path: 'C:\\temp\\report.pdf', language: 'en' }]);
  }

  // 2. Chinese navigator.languages auto-detection
  {
    const payloads = [];
    const sandbox = createMockDom({ navigator: { language: 'en-US', languages: ['zh-CN', 'en-US'] }, intlLocale: 'en-US' });
    sandbox.agyFileActionsV1 = payload => payloads.push(JSON.parse(payload));
    vm.runInNewContext(makeRendererSource('agyFileActionsV1'), sandbox);

    const { menu } = triggerContextMenu(sandbox, 'C:\\temp\\note.md');
    assert.equal(menu.lang, 'zh-CN');
    assert.equal(menu.querySelector('[data-action="reveal"] .agy-action-label').textContent, MESSAGES.zh.reveal);
    assert.equal(menu.querySelector('[data-action="copy-content"]').disabled, false);
    assert.equal(menu.querySelector('[data-action="copy-content"]').title, MESSAGES.zh.copyContentEnabledTitle);

    menu.querySelector('[data-action="copy-path"]').click();
    assert.equal(sandbox.document.getElementById('agy-file-actions-toast').textContent, MESSAGES.zh.toastPathCopied);
    assert.deepEqual(payloads, [{ action: 'copy-path', path: 'C:\\temp\\note.md', language: 'zh' }]);
  }

  // 3. Sidecar-injected language overrides English Chromium, runtime override updates on next open, and dispose removes listeners
  {
    const sandbox = createMockDom({ navigator: { language: 'en-US', languages: ['en-US'] }, intlLocale: 'en-US' });
    sandbox.agyFileActionsV1 = () => {};
    vm.runInNewContext(makeRendererSource('agyFileActionsV1', { language: 'zh' }), sandbox);

    const first = triggerContextMenu(sandbox, 'C:\\temp\\a.txt');
    assert.equal(first.menu.querySelector('[data-action="save-as"] .agy-action-label').textContent, MESSAGES.zh.saveAs);

    sandbox.__agyFileActionsLang = 'en';
    const second = triggerContextMenu(sandbox, 'C:\\temp\\a.txt');
    assert.equal(second.menu.querySelector('[data-action="save-as"] .agy-action-label').textContent, MESSAGES.en.saveAs);

    assert.equal(sandbox.winListeners.get('languagechange').size, 1);
    assert.equal(sandbox.docListeners.get('contextmenu').size, 1);
    sandbox.__agyFileActionsDispose();
    assert.equal(sandbox.winListeners.get('languagechange').size, 0);
    assert.equal(sandbox.docListeners.get('contextmenu').size, 0);
    assert.equal(sandbox.docListeners.get('pointerdown').size, 0);
    assert.equal(sandbox.docListeners.get('keydown').size, 0);
  }
});
