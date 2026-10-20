// Genera la imagen de una escena con Gemini (y OpenAI como respaldo)
// a traves de Netlify AI Gateway. No requiere API key propia.
import { GoogleGenAI } from '@google/genai';
import OpenAI from 'openai';

const GEMINI = ['gemini-3.1-flash-image', 'gemini-2.5-flash-image', 'gemini-3-pro-image'];
const OPENAI = ['gpt-image-2', 'gpt-image-1.5'];

const TAMANOS_OPENAI = { '16:9': '1536x1024', '9:16': '1024x1536', '1:1': '1024x1024' };

async function conGemini(prompt, aspecto, referencia) {
  const ai = new GoogleGenAI({});
  const partes = [];
  if (referencia) {
    partes.push({ inlineData: { mimeType: 'image/jpeg', data: referencia } });
    partes.push({ text: 'Use the attached image only as a reference for the characters and art style, keep them consistent. Create a NEW scene: ' + prompt });
  } else {
    partes.push({ text: prompt });
  }
  let ultimo;
  for (const model of GEMINI) {
    try {
      const r = await ai.models.generateContent({
        model,
        contents: [{ role: 'user', parts: partes }],
        config: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: aspecto } }
      });
      const p = r?.candidates?.[0]?.content?.parts?.find(x => x.inlineData?.data);
      if (p) return { mime: p.inlineData.mimeType || 'image/png', data: p.inlineData.data, modelo: model };
      throw new Error('Respuesta sin imagen');
    } catch (e) { ultimo = e; console.error(`Fallo ${model}:`, e?.message); }
  }
  throw ultimo;
}

async function conOpenAI(prompt, aspecto) {
  const ai = new OpenAI();
  let ultimo;
  for (const model of OPENAI) {
    try {
      const r = await ai.images.generate({
        model, prompt,
        size: TAMANOS_OPENAI[aspecto] || '1536x1024',
        quality: 'medium',
        output_format: 'jpeg',
        output_compression: 85
      });
      const b64 = r?.data?.[0]?.b64_json;
      if (b64) return { mime: 'image/jpeg', data: b64, modelo: model };
      throw new Error('Respuesta sin imagen');
    } catch (e) { ultimo = e; console.error(`Fallo ${model}:`, e?.message); }
  }
  throw ultimo;
}

export default async (req) => {
  if (req.method !== 'POST') return Response.json({ error: 'Usa POST' }, { status: 405 });
  let body;
  try { body = await req.json(); } catch { return Response.json({ error: 'JSON invalido' }, { status: 400 }); }

  const escena = String(body.prompt || '').slice(0, 3000);
  if (!escena) return Response.json({ error: 'Falta la descripcion de la escena' }, { status: 400 });

  const aspecto = ['16:9', '9:16', '1:1'].includes(body.aspecto) ? body.aspecto : '16:9';
  const estilo = String(body.estilo || '').slice(0, 300);
  const personajes = String(body.personajes || '').slice(0, 1500);
  const ambientacion = String(body.ambientacion || '').slice(0, 800);
  const referencia = typeof body.referencia === 'string' && body.referencia.length < 3_000_000 ? body.referencia : null;

  const prompt = [
    `Art style: ${estilo}.`,
    personajes && `Characters (keep identical in every scene): ${personajes}.`,
    ambientacion && `World and color palette: ${ambientacion}.`,
    `Scene: ${escena}`,
    'Cinematic composition, high detail, no text, no letters, no watermark, no captions.'
  ].filter(Boolean).join('\n');

  try {
    const img = await conGemini(prompt, aspecto, referencia);
    return Response.json(img);
  } catch (e1) {
    try {
      const img = await conOpenAI(prompt, aspecto);
      return Response.json(img);
    } catch (e2) {
      return Response.json({ error: 'No se pudo generar la imagen: ' + (e2?.message || e1?.message) }, { status: 502 });
    }
  }
};

export const config = { path: '/api/imagen' };
