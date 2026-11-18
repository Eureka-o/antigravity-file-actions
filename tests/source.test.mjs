import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractFilePath, makeRendererSource } from '../sidecars/file-actions/source.mjs';
import { buildActionSpec, inspectTarget, runAction, safePath } from '../sidecars/file-actions/actions.mjs';

test('renderer source installs only file-scoped context actions', () => {
  const source = makeRendererSource('agyFileActionsV1');
  assert.match(source, /contextmenu/);
  assert.match(source, /data-path/);
  assert.match(source, /在资源管理器中打开/);
  assert.match(source, /在侧边栏中打开/);
  assert.match(source, /在默认应用中打开/);
  assert.match(source, /agyFileActionsV1/);
  assert.match(source, /--glass-border/);
  assert.match(source, /prefers-color-scheme:\s*dark/);
  assert.match(source, /agy-file-actions-submenu/);
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
