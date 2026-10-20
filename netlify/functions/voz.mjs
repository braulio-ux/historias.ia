// Narracion con voz IA (MP3) para que el audio quede dentro del video exportado.
// Orden de proveedores:
//  1) OPENAI_TTS_API_KEY  (clave propia de OpenAI, solo para voz)
//  2) ELEVENLABS_API_KEY  (clave propia de ElevenLabs)
//  3) Netlify AI Gateway  (se intenta; si el gateway no ofrece voz, responde 501)
// Si nada esta disponible, la app usa la voz del navegador automaticamente.

const VOCES_OPENAI = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse'];
const VOZ_ELEVEN_DEFECTO = process.env.ELEVENLABS_VOICE_ID || 'EXAVITQu4vr4xnSDxMaL';

async function openaiTTS({ base, key, texto, voz, tono }) {
  const r = await fetch(`${base}/v1/audio/speech`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: 'gpt-4o-mini-tts',
      voice: VOCES_OPENAI.includes(voz) ? voz : 'nova',
      input: texto,
      instructions: tono || 'Narrador de cuentos calido, expresivo y pausado.',
      response_format: 'mp3'
    })
  });
  if (!r.ok) throw new Error(`OpenAI TTS ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return new Uint8Array(await r.arrayBuffer());
}

async function elevenTTS({ texto }) {
  const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${VOZ_ELEVEN_DEFECTO}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'xi-api-key': process.env.ELEVENLABS_API_KEY, Accept: 'audio/mpeg' },
    body: JSON.stringify({ text: texto, model_id: 'eleven_multilingual_v2', voice_settings: { stability: 0.45, similarity_boost: 0.8, style: 0.35 } })
  });
  if (!r.ok) throw new Error(`ElevenLabs ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return new Uint8Array(await r.arrayBuffer());
}

async function sintetizar(params) {
  if (process.env.OPENAI_TTS_API_KEY) {
    return { audio: await openaiTTS({ ...params, base: 'https://api.openai.com', key: process.env.OPENAI_TTS_API_KEY }), proveedor: 'openai' };
  }
  if (process.env.ELEVENLABS_API_KEY) {
    return { audio: await elevenTTS(params), proveedor: 'elevenlabs' };
  }
  const base = process.env.NETLIFY_AI_GATEWAY_URL ? `${process.env.NETLIFY_AI_GATEWAY_URL.replace(/\/$/, '')}/openai` : process.env.OPENAI_BASE_URL;
  const key = process.env.NETLIFY_AI_GATEWAY_KEY || process.env.OPENAI_API_KEY;
  const intentos = [];
  if (process.env.OPENAI_BASE_URL && process.env.OPENAI_API_KEY) intentos.push({ base: process.env.OPENAI_BASE_URL.replace(/\/v1\/?$/, '').replace(/\/$/, ''), key: process.env.OPENAI_API_KEY });
  if (base && key) intentos.push({ base: base.replace(/\/v1\/?$/, ''), key });
  let ultimo = new Error('Sin proveedor de voz');
  for (const i of intentos) {
    try { return { audio: await openaiTTS({ ...params, ...i }), proveedor: 'gateway' }; }
    catch (e) { ultimo = e; }
  }
  throw ultimo;
}

let estadoCache = null;

export default async (req) => {
  if (req.method === 'GET') {
    if (!estadoCache) {
      try {
        const { proveedor } = await sintetizar({ texto: 'Hola.', voz: 'nova' });
        estadoCache = { disponible: true, proveedor };
      } catch (e) {
        estadoCache = { disponible: false, motivo: e.message };
      }
    }
    return Response.json(estadoCache);
  }

  if (req.method !== 'POST') return Response.json({ error: 'Usa POST' }, { status: 405 });
  let body;
  try { body = await req.json(); } catch { return Response.json({ error: 'JSON invalido' }, { status: 400 }); }

  const texto = String(body.texto || '').slice(0, 4000).trim();
  if (!texto) return Response.json({ error: 'Falta el texto' }, { status: 400 });

  try {
    const { audio, proveedor } = await sintetizar({ texto, voz: body.voz, tono: body.tono });
    return new Response(audio, { headers: { 'content-type': 'audio/mpeg', 'x-proveedor': proveedor, 'cache-control': 'no-store' } });
  } catch (e) {
    return Response.json({ error: 'Voz IA no disponible: ' + e.message }, { status: 501 });
  }
};

export const config = { path: '/api/voz' };
