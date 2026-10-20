// Genera el guion de la historia (escenas, narracion y descripciones visuales)
// usando Claude a traves de Netlify AI Gateway. No requiere API key propia.
import Anthropic from '@anthropic-ai/sdk';

const MODELOS = ['claude-sonnet-5-5', 'claude-sonnet-4-6', 'claude-haiku-5-5', 'claude-haiku-4-5'];

const SISTEMA = `Eres un guionista y director de arte de cortos animados.
Recibes una descripcion de historia y devuelves SOLO un objeto JSON valido, sin texto antes ni despues, sin bloques de codigo.
Estructura exacta:
{
  "titulo": "string corto",
  "sinopsis": "1-2 frases",
  "personajes": "descripcion visual fija y detallada de cada personaje (ropa, colores, edad, rasgos) para mantener coherencia entre imagenes, en ingles",
  "ambientacion": "descripcion visual del mundo/paleta de color, en ingles",
  "escenas": [
    {
      "narracion": "texto que lee el narrador en esta escena, en el idioma pedido, 1 a 3 frases",
      "prompt_imagen": "descripcion visual concreta de la imagen de esta escena, en ingles, incluyendo encuadre, accion, luz y emocion. No incluir texto ni letras en la imagen.",
      "camara": "zoom-in | zoom-out | pan-izquierda | pan-derecha | pan-arriba | pan-abajo",
      "ambiente": "alegre | misterioso | tenso | triste | epico | tranquilo | magico",
      "efecto": "ninguno | particulas | lluvia | nieve | luciernagas | brillo"
    }
  ]
}
Reglas: respeta el numero de escenas pedido. La historia debe tener inicio, desarrollo y cierre. Narracion natural para ser leida en voz alta. Contenido apto para todo publico salvo que el usuario indique lo contrario dentro de lo apropiado.`;

function extraerJSON(texto) {
  const limpio = texto.replace(/```json|```/g, '').trim();
  const ini = limpio.indexOf('{');
  const fin = limpio.lastIndexOf('}');
  if (ini === -1 || fin === -1) throw new Error('La IA no devolvio JSON');
  return JSON.parse(limpio.slice(ini, fin + 1));
}

export default async (req) => {
  if (req.method !== 'POST') return Response.json({ error: 'Usa POST' }, { status: 405 });

  let body;
  try { body = await req.json(); } catch { return Response.json({ error: 'JSON invalido' }, { status: 400 }); }

  const descripcion = String(body.descripcion || '').slice(0, 6000).trim();
  if (descripcion.length < 10) return Response.json({ error: 'Describe tu historia con un poco mas de detalle.' }, { status: 400 });

  const escenas = Math.min(Math.max(parseInt(body.escenas) || 6, 2), 12);
  const idioma = String(body.idioma || 'espanol');
  const estilo = String(body.estilo || 'animacion 3D estilo cine').slice(0, 200);
  const publico = String(body.publico || 'todo publico').slice(0, 100);

  const pedido = `Descripcion de la historia:\n${descripcion}\n\nNumero de escenas: ${escenas}\nIdioma de la narracion: ${idioma}\nEstilo visual: ${estilo}\nPublico: ${publico}`;

  const ai = new Anthropic();
  let ultimoError;

  for (const model of MODELOS) {
    try {
      const msg = await ai.messages.create({
        model,
        max_tokens: 4000,
        system: SISTEMA,
        messages: [{ role: 'user', content: pedido }]
      });
      const texto = msg.content.filter(b => b.type === 'text').map(b => b.text).join('');
      const guion = extraerJSON(texto);
      if (!Array.isArray(guion.escenas) || !guion.escenas.length) throw new Error('Guion sin escenas');
      guion.modelo = model;
      return Response.json(guion);
    } catch (e) {
      ultimoError = e;
      console.error(`Fallo ${model}:`, e?.message);
    }
  }

  return Response.json({ error: 'No se pudo generar la historia: ' + (ultimoError?.message || 'error desconocido') }, { status: 502 });
};

export const config = { path: '/api/historia' };
