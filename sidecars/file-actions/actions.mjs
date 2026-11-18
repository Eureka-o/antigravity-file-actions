import { statSync } from 'node:fs';
import { win32 } from 'node:path';
import { spawn } from 'node:child_process';

export const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'tex', 'json', 'jsonl', 'csv', 'tsv', 'xml', 'svg',
  'html', 'htm', 'css', 'scss', 'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx',
  'py', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'log', 'sh', 'bat',
  'cmd', 'ps1', 'sql', 'bib', 'cls', 'sty', 'c', 'cpp', 'h', 'hpp', 'rs',
  'go', 'java',
]);

export const MAX_COPY_CONTENT_BYTES = 1048576;

export function encodedPowerShell(script) {
  return Buffer.from(script, 'utf16le').toString('base64');
}

function psEscape(value) {
  return String(value).replaceAll("'", "''");
}

export function safePath(value) {
  if (typeof value !== 'string' || /[\0\r\n"]/.test(value)) return '';
  const trimmed = value.trim();
  if (!/^(?:[A-Za-z]:[\\/]|\\\\)/.test(trimmed)) return '';
  const normalized = win32.normalize(trimmed);
  const cleaned = normalized.length > 3 && normalized.endsWith('\\')
    ? normalized.slice(0, -1)
    : normalized;
  try {
    statSync(cleaned);
    return cleaned;
  } catch {
    return '';
  }
}

export function inspectTarget(rawPath) {
  const target = safePath(rawPath);
  if (!target) return null;
  try {
    const stat = statSync(target);
    return {
      path: target,
      isDirectory: stat.isDirectory(),
      isFile: stat.isFile(),
      size: stat.size,
    };
  } catch {
    return null;
  }
}

function psSpec(script, { sta = false } = {}) {
  const args = ['-NoProfile', '-NonInteractive'];
  if (sta) args.push('-STA');
  args.push('-EncodedCommand', encodedPowerShell(script));
  return {
    command: 'powershell.exe',
    args,
    // Detached PowerShell on Windows exits immediately without running -EncodedCommand
    // because DETACHED_PROCESS removes its console host before startup completes.
    options: {
      detached: false,
      stdio: 'ignore',
      windowsHide: true,
    },
  };
}

export function buildActionSpec(action, info) {
  if (!info?.path) return null;
  const target = info.path;

  if (action === 'reveal') {
    const isDriveRoot = /^[A-Za-z]:\\$/.test(target);
    const arg = info.isDirectory
      ? (isDriveRoot ? target : `"${target}"`)
      : `/select,"${target}"`;
    return {
      command: 'explorer.exe',
      args: [arg],
      options: {
        // Explorer's /select, parser fails if Node wraps "/select,<path>" in outer quotes.
        windowsVerbatimArguments: true,
        detached: true,
        stdio: 'ignore',
        windowsHide: false,
      },
    };
  }

  if (action === 'open-default') {
    return psSpec(`Start-Process -LiteralPath '${psEscape(target)}'`);
  }

  if (action === 'open-with') {
    if (info.isDirectory) return null;
    return {
      command: 'rundll32.exe',
      args: [`shell32.dll,OpenAs_RunDLL ${target}`],
      options: {
        // OpenAs_RunDLL expects the unquoted command tail after the entry point name.
        windowsVerbatimArguments: true,
        detached: true,
        stdio: 'ignore',
        windowsHide: false,
      },
    };
  }

  if (action === 'save-as') {
    if (!info.isFile) return null;
    const source = psEscape(target);
    const script = [
      'Add-Type -AssemblyName System.Windows.Forms',
      `$source = '${source}'`,
      '$ext = [IO.Path]::GetExtension($source)',
      '$owner = New-Object System.Windows.Forms.Form',
      '$owner.TopMost = $true',
      '$dialog = New-Object System.Windows.Forms.SaveFileDialog',
      '$dialog.InitialDirectory = [IO.Path]::GetDirectoryName($source)',
      '$dialog.FileName = [IO.Path]::GetFileName($source)',
      "if ($ext) { $label = $ext.TrimStart('.').ToUpperInvariant(); $dialog.Filter = \"$label (*$ext)|*$ext|All files (*.*)|*.*\" } else { $dialog.Filter = 'All files (*.*)|*.*' }",
      'if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { [IO.File]::Copy($source, $dialog.FileName, $true) }',
      '$owner.Dispose()',
    ].join('; ');
    return psSpec(script, { sta: true });
  }

  if (action === 'copy-path') {
    return psSpec(`Set-Clipboard -Value '${psEscape(target)}'`, { sta: true });
  }

  if (action === 'copy-content') {
    if (!info.isFile) return null;
    const extension = target.split('.').pop().toLowerCase();
    if (!TEXT_EXTENSIONS.has(extension) || info.size > MAX_COPY_CONTENT_BYTES) return null;
    const source = psEscape(target);
    const script = `$text = [IO.File]::ReadAllText('${source}'); if ($text.Length -eq 0) { Set-Clipboard -Value $null } else { Set-Clipboard -Value $text }`;
    return psSpec(script, { sta: true });
  }

  return null;
}

export function runAction(action, rawPath, { spawnImpl = spawn, platform = process.platform } = {}) {
  const info = inspectTarget(rawPath);
  if (!info) {
    console.warn('[file-actions] ignored action with invalid or missing path');
    return false;
  }
  if (platform !== 'win32') {
    console.warn('[file-actions] action unavailable on this platform');
    return false;
  }
  const spec = buildActionSpec(action, info);
  if (!spec) {
    console.warn(`[file-actions] unsupported action or target: ${String(action).slice(0, 32)}`);
    return false;
  }
  console.info(`[file-actions] action received: ${String(action).slice(0, 32)}`);
  const child = spawnImpl(spec.command, spec.args, spec.options);
  child.on('error', error => console.error(`[file-actions] ${spec.command} failed: ${error.code || error.name}`));
  if (spec.options.detached) child.unref();
  return true;
}
