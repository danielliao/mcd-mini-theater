#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function namespace(code) {
  const names = [...code.matchAll(/^export\s+(?:async\s+)?(?:function|class|const|let)\s+([A-Za-z_$][\w$]*)/gm)].map(m => m[1]);
  if (!names.length || /export\s+default|^import\s/m.test(code)) throw new Error('独立版只支持无依赖、命名导出的模块。');
  return `(() => {\n${code.replace(/^export\s+/gm, '')}\nreturn {${names.join(',')}};\n})()`;
}

export async function buildStandalone(initialStory = null) {
  const [html, css, core, characters, app] = await Promise.all([
    readFile(resolve(root, 'web/index.html'), 'utf8'),
    readFile(resolve(root, 'web/styles.css'), 'utf8'),
    readFile(resolve(root, 'src/theater.mjs'), 'utf8'),
    readFile(resolve(root, 'web/characters.mjs'), 'utf8'),
    readFile(resolve(root, 'web/app.mjs'), 'utf8'),
  ]);
  let appCode = app.replace(/import\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"];?/g, (_, names, path) => {
    const ns = path.endsWith('/theater.mjs') ? '__theaterCore' : path.endsWith('/characters.mjs') || path === './characters.mjs' ? '__theaterCharacters' : null;
    if (!ns) throw new Error('独立版发现未知的外部导入。');
    return `const {${names.replace(/\bas\b/g, ':')}} = ${ns};`;
  });
  if (/^\s*import\s/m.test(appCode)) throw new Error('独立版发现不支持的导入语法。');
  const initial = initialStory ? `globalThis.__MCD_THEATER_INITIAL_STORY__ = ${JSON.stringify(initialStory).replace(/</g, '\\u003c')};\n` : '';
  const script = `${initial}const __theaterCore = ${namespace(core)};\nconst __theaterCharacters = ${namespace(characters)};\n${appCode}`;
  return html
    .replace(/<link\b[^>]*href=["'](?:\.\/)?styles\.css["'][^>]*>/i, `<style>${css}</style>`)
    .replace(/<script\b[^>]*src=["'](?:\.\/)?app\.mjs["'][^>]*>\s*<\/script>/i, `<script type="module">${script.replace(/<\/script/gi, '<\\/script')}</script>`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const output = resolve(root, 'app.html');
  await writeFile(output, await buildStandalone());
  console.log('已生成 app.html，可以直接双击体验。');
}
