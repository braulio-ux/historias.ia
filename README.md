# Estudio de Historias IA

Escribes una descripcion de tu historia y la app crea, sola, un video animado: guion, ilustraciones por escena, narracion, musica, subtitulos, movimientos de camara, efectos y transiciones. Se exporta como MP4 (o WebM segun el navegador).

Funciona con **Netlify AI Gateway**: no necesitas claves de OpenAI, Anthropic ni Google.

| Parte | Modelo (via Netlify AI Gateway) |
|---|---|
| Guion y escenas | Claude Sonnet 5.5 (respaldos: Sonnet 4.6, Haiku) |
| Imagenes | Gemini 3.1 Flash Image (respaldo: GPT Image 2) |
| Animacion, musica, subtitulos y video | Se generan en el navegador, sin costo |
| Narracion | Voz IA si esta disponible; si no, voz del navegador |

## Publicarlo en Netlify

Opcion A, con GitHub (recomendada)
1. Sube esta carpeta a un repositorio de GitHub.
2. En Netlify: Add new project > Import an existing project > elige el repositorio.
3. Deja la configuracion como viene (ya esta en `netlify.toml`) y pulsa Deploy.

Opcion B, con la terminal
```
npm install
npx netlify-cli login
npx netlify-cli deploy --prod
```

Importante: el AI Gateway se activa despues del primer despliegue a produccion. Si la primera prueba falla, espera un minuto y vuelve a intentar. El sitio debe estar en un plan de Netlify con creditos (Free, Personal o Pro).

> No uses "Netlify Drop" (arrastrar la carpeta): ese metodo no instala las dependencias de las funciones.

## Narracion dentro del video

Netlify AI Gateway hoy no ofrece modelos de voz. La app lo intenta igual; si no hay voz IA, usa la voz del navegador para la vista previa, y el video exportado sale con musica y subtitulos pero sin narracion.

Para que la voz quede grabada en el video, agrega UNA de estas variables en Netlify (Project configuration > Environment variables) y vuelve a desplegar:

- `OPENAI_TTS_API_KEY` = tu clave de OpenAI (solo se usa para la voz; lo demas sigue por el Gateway).
- `ELEVENLABS_API_KEY` = tu clave de ElevenLabs. Opcional: `ELEVENLABS_VOICE_ID` para elegir la voz.

No uses el nombre `OPENAI_API_KEY`, porque reemplazaria el Gateway para las imagenes.

## Uso

1. Escribe la historia, elige numero de escenas, formato (16:9, 9:16 o 1:1), estilo, idioma y voz.
2. Pulsa "Crear historia animada".
3. En el tablero puedes editar la narracion, cambiar camara y efecto, regenerar o subir una imagen propia por escena.
4. "Exportar video" graba en tiempo real: deja la pestana abierta y visible hasta que descargue.
5. "Guardar proyecto" descarga un archivo `.historia.json` para retomarlo luego con "Abrir proyecto".

## Costos

Cada historia consume creditos de Netlify: un guion y una imagen por escena. Revisa el consumo en Netlify > Usage.

## Estructura

```
netlify.toml
package.json
netlify/functions/historia.mjs   guion con Claude
netlify/functions/imagen.mjs     imagenes con Gemini / OpenAI
netlify/functions/voz.mjs        narracion (opcional)
public/index.html, app.js, estilos.css
```
