// Caption translation for the Language room. Text in, text out; nothing is
// stored and no identity is sent. DEEPL_API_KEY → DeepL (free tier works:
// api-free.deepl.com); otherwise translation is off and captions show as spoken.
const cache = new Map(); // "src>tgt:text" → translation, bounded

function makeTranslator(env) {
  const key = env.DEEPL_API_KEY;
  if (!key) return null;
  const host = key.endsWith(':fx') ? 'https://api-free.deepl.com' : 'https://api.deepl.com';
  return async function translate(text, srcLang, tgtLang) {
    const src = (srcLang || '').slice(0, 2).toUpperCase();
    const tgt = tgtLang.toUpperCase();
    const k = `${src}>${tgt}:${text}`;
    if (cache.has(k)) return cache.get(k);
    const body = new URLSearchParams({ text, target_lang: tgt === 'EN' ? 'EN-US' : tgt === 'PT' ? 'PT-BR' : tgt });
    if (src) body.set('source_lang', src);
    const res = await fetch(`${host}/v2/translate`, { method: 'POST', headers: { authorization: `DeepL-Auth-Key ${key}` }, body, signal: AbortSignal.timeout(4000) });
    if (!res.ok) throw new Error(`deepl ${res.status}`);
    const j = await res.json();
    const out = j.translations?.[0]?.text || '';
    if (cache.size > 2000) cache.delete(cache.keys().next().value);
    cache.set(k, out);
    return out;
  };
}
module.exports = { makeTranslator };
