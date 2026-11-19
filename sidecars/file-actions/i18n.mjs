import { execFile } from 'node:child_process';

export const MESSAGES = {
  zh: {
    menuLabel: '文件操作',
    submenuLabel: '打开方式',
    reveal: '在资源管理器中打开',
    openFile: '在侧边栏中打开',
    openDefault: '在默认应用中打开',
    openWith: '打开方式',
    chooseApp: '选择其他应用…',
    saveAs: '另存为…',
    copyPath: '复制路径',
    copyContent: '复制文件内容',
    toastPathCopied: '已复制路径',
    toastContentCopied: '已复制文件内容',
    copyContentDisabledTitle: '仅支持文本文件，PDF、PPTX、DOCX 或文件夹无法复制为文本',
    copyContentEnabledTitle: '复制文本内容（不超过 1 MiB）',
    saveAsAllFiles: '所有文件',
  },
  en: {
    menuLabel: 'File Actions',
    submenuLabel: 'Open With',
    reveal: 'Reveal in File Explorer',
    openFile: 'Open in Sidebar',
    openDefault: 'Open in Default App',
    openWith: 'Open With',
    chooseApp: 'Choose Another App…',
    saveAs: 'Save As…',
    copyPath: 'Copy Path',
    copyContent: 'Copy File Contents',
    toastPathCopied: 'Path copied',
    toastContentCopied: 'File contents copied',
    copyContentDisabledTitle: 'Text files only; PDF, PPTX, DOCX, and folders cannot be copied as text',
    copyContentEnabledTitle: 'Copy text contents (up to 1 MiB)',
    saveAsAllFiles: 'All files',
  },
};

const WIN_LANGUAGE_KEYS = [
  ['HKCU\\Control Panel\\Desktop', 'PreferredUILanguages'],
  ['HKCU\\Control Panel\\Desktop\\MuiCached', 'MachinePreferredUILanguages'],
  ['HKCU\\Control Panel\\International', 'LocaleName'],
];

/**
 * Normalize a locale tag to `'zh'`, `'en'`, or `''` when unspecified/neutral.
 * Kept self-contained because source.mjs serializes it into the renderer page.
 */
export function normalizeLanguage(locale) {
  if (typeof locale !== 'string') return '';
  const lower = locale.trim().toLowerCase();
  if (!lower || lower === 'auto' || lower === 'c' || lower === 'posix'
    || lower.startsWith('c.') || lower.startsWith('posix.')) {
    return '';
  }
  return /^zh(?:$|[-_.@])/.test(lower) ? 'zh' : 'en';
}

/** Return the translation dictionary for the resolved language. */
export function getMessages(language) {
  return MESSAGES[normalizeLanguage(language) === 'zh' ? 'zh' : 'en'];
}

/** Extract the first locale entry from `reg.exe query` stdout. */
export function parseRegQueryLocale(stdout, valueName = '') {
  if (typeof stdout !== 'string' || !stdout) return '';
  const expected = valueName ? valueName.toLowerCase() : '';
  for (const line of stdout.split(/\r?\n/)) {
    const match = line.match(/^\s*(\S+)\s+REG_(?:MULTI_)?SZ\s+(.+?)\s*$/);
    if (!match) continue;
    if (expected && match[1].toLowerCase() !== expected) continue;
    const token = match[2].split(/\\0|\0/).map(part => part.trim()).find(Boolean);
    if (token) return token;
  }
  return '';
}

function detectEnvLanguage(env) {
  if (!env) return '';
  for (const key of ['AGY_FILE_ACTIONS_LANG', 'LC_ALL', 'LC_MESSAGES', 'LANG']) {
    const lang = normalizeLanguage(env[key]);
    if (lang) return lang;
  }
  return '';
}

function detectIntlLanguage(intlLocale) {
  if (intlLocale !== undefined) return normalizeLanguage(intlLocale);
  try {
    return normalizeLanguage(Intl.DateTimeFormat().resolvedOptions().locale);
  } catch {
    return '';
  }
}

function queryRegValue(execFileImpl, key, valueName) {
  return new Promise(resolve => {
    try {
      execFileImpl(
        'reg.exe',
        ['query', key, '/v', valueName],
        { windowsHide: true, timeout: 1500, encoding: 'utf8' },
        (error, stdout) => {
          resolve(error ? '' : parseRegQueryLocale(stdout, valueName));
        }
      );
    } catch {
      resolve('');
    }
  });
}

/** Synchronously resolve `'zh'` or `'en'` from environment overrides or JS Intl locale. */
export function detectSystemLanguageSync({ env = process.env, intlLocale } = {}) {
  return detectEnvLanguage(env) || detectIntlLanguage(intlLocale) || 'en';
}

/** Asynchronously resolve `'zh'` or `'en'`, preferring Windows UI language settings. */
export async function detectSystemLanguage({
  env = process.env,
  platform = process.platform,
  execFileImpl = execFile,
  intlLocale,
} = {}) {
  const fromEnv = detectEnvLanguage(env);
  if (fromEnv) return fromEnv;

  if (platform === 'win32') {
    for (const [key, valueName] of WIN_LANGUAGE_KEYS) {
      const raw = await queryRegValue(execFileImpl, key, valueName);
      const lang = normalizeLanguage(raw);
      if (lang) return lang;
    }
  }

  return detectIntlLanguage(intlLocale) || 'en';
}
