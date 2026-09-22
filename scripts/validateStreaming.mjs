import { access, readFile } from 'node:fs/promises';

const repository = process.env.STREAM_CONTENT_REPOSITORY || 'gabrielsaimo/SaimoPlayer';
const branch = process.env.STREAM_CONTENT_BRANCH || 'main';
const rawBase = `https://raw.githubusercontent.com/${repository}/${branch}`;

const criticalFiles = [
  'src/components/VideoPlayer.tsx',
  'src/components/MoviePlayer.tsx',
  'src/services/catalogService.ts',
  'src/utils/hlsLoader.ts',
  'src/utils/streamUrl.ts',
  'functions/api/proxy.ts',
];

function countSources(text) {
  if (text.trimStart().startsWith('#EXTM3U')) {
    return text.split(/\r?\n/).filter(line => {
      const value = line.trim();
      return value && !value.startsWith('#') && /^(https?|rtmp):\/\//i.test(value);
    }).length;
  }

  return text.split(/\r?\n/).filter(line => /^fonte\s*:\s*\S+/i.test(line.trim())).length;
}

async function validateLocalFiles() {
  for (const file of criticalFiles) {
    await access(file);
    const contents = await readFile(file, 'utf8');
    if (contents.trim().length < 100) throw new Error(`${file} está vazio ou incompleto.`);
  }
}

async function fetchList(name) {
  const url = `${rawBase}/${name}`;
  const response = await fetch(url, {
    headers: { 'user-agent': 'Saimo-TV-stream-validation' },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`${name}: GitHub respondeu HTTP ${response.status}.`);

  const text = await response.text();
  const sources = countSources(text);
  if (sources === 0) throw new Error(`${name}: nenhuma fonte de transmissão válida encontrada.`);
  return { name, sources, bytes: Buffer.byteLength(text) };
}

await validateLocalFiles();
const lists = await Promise.all([fetchList('catalogo.txt'), fetchList('canais.txt')]);

console.log(`Arquivos essenciais: ${criticalFiles.length} OK`);
for (const list of lists) {
  console.log(`${list.name}: ${list.sources} fontes, ${list.bytes} bytes`);
}
