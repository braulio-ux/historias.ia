/* Estudio de Historias IA
 * Flujo: guion (Claude) -> imagenes (Gemini / OpenAI) -> narracion (voz IA o voz del navegador)
 * -> animacion en canvas (camara, transiciones, efectos, subtitulos, musica) -> exportacion a video.
 */
(() => {
'use strict';

// ---------- Utilidades ----------
const $ = (s, r = document) => r.querySelector(s);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const suave = p => 0.5 - 0.5 * Math.cos(Math.PI * clamp(p, 0, 1));
const espera = ms => new Promise(r => setTimeout(r, ms));
const fmt = s => { s = Math.max(0, Math.floor(s)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const slug = t => (t || 'historia').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'historia';
function semilla(n) { return () => { n |= 0; n = n + 0x6D2B79F5 | 0; let t = Math.imul(n ^ n >>> 15, 1 | n); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

async function pedirJSON(url, body, intentos = 2) {
  let ultimo;
  for (let i = 0; i < intentos; i++) {
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const tipo = r.headers.get('content-type') || '';
      if (!tipo.includes('json')) throw new Error(r.status === 404 ? 'Funcion no encontrada (el sitio debe estar desplegado en Netlify o usar netlify dev)' : `Error ${r.status}`);
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || `Error ${r.status}`);
      return j;
    } catch (e) { ultimo = e; if (i < intentos - 1) await espera(2000 * (i + 1)); }
  }
  throw ultimo;
}

async function enParalelo(items, n, fn) {
  let i = 0;
  const trabajadores = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; await fn(items[k], k); }
  });
  await Promise.all(trabajadores);
}

const cargarImagen = src => new Promise((ok, mal) => { const im = new Image(); im.onload = () => ok(im); im.onerror = mal; im.src = src; });

function miniatura64(img, max = 640) {
  const c = document.createElement('canvas');
  const k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
  c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.82).split(',')[1];
}

const b64DeBuffer = buf => { let s = ''; const b = new Uint8Array(buf); for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000)); return btoa(s); };
const bufferDeB64 = b64 => { const s = atob(b64); const b = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i); return b.buffer; };

// ---------- Estado ----------
const TAMANOS = { '16:9': [1280, 720], '9:16': [720, 1280], '1:1': [1080, 1080] };
const INTRO = 3.6, OUTRO = 3.2, FUNDIDO = 0.9, PREVOZ = 0.35;

const estado = {
  guion: null, escenas: [], aspecto: '16:9', idioma: 'espanol', lang: 'es', voz: 'nova', estilo: '',
  musica: true, subs: true, vozIA: null, clips: [], duracion: 0, musicaBuffer: null, musicaFirma: ''
};

const lienzo = $('#lienzo');
const g = lienzo.getContext('2d');
let ac = null, master = null, destino = null, busMusica = null;

function asegurarAudio() {
  if (ac) return;
  ac = new (window.AudioContext || window.webkitAudioContext)();
  master = ac.createGain(); master.gain.value = 1;
  destino = ac.createMediaStreamDestination();
  master.connect(ac.destination); master.connect(destino);
  busMusica = ac.createGain(); busMusica.gain.value = 0.55; busMusica.connect(master);
}

// ---------- UI basica ----------
const ui = {
  desc: $('#descripcion'), num: $('#numEscenas'), numTxt: $('#numEscenasTxt'), aspecto: $('#aspecto'),
  estilo: $('#estilo'), estiloLibre: $('#estiloLibre'), campoEstilo: $('#campoEstiloLibre'), idioma: $('#idioma'),
  voz: $('#voz'), publico: $('#publico'), musica: $('#optMusica'), subs: $('#optSubs'), coherencia: $('#optCoherencia'),
  crear: $('#btnCrear'), progreso: $('#progreso'), msj: $('#mensaje'), play: $('#btnPlay'), linea: $('#linea'),
  tiempo: $('#tiempo'), exportar: $('#btnExportar'), nota: $('#notaExport'), barra: $('#barraExport'), vacio: $('#vacio'),
  marco: $('#marco'), story: $('#panelStory'), tablero: $('#tablero'), titulo: $('#tituloHistoria'), sinopsis: $('#sinopsis'),
  chipVoz: $('#chipVoz'), guardar: $('#btnGuardar'), cargar: $('#btnCargar'), archivo: $('#archivoProyecto'), revoz: $('#btnRevoz')
};

ui.num.addEventListener('input', () => ui.numTxt.textContent = ui.num.value);
ui.estilo.addEventListener('change', () => ui.campoEstilo.hidden = ui.estilo.value !== 'custom');
ui.musica.addEventListener('change', () => { estado.musica = ui.musica.checked; if (rep.sonando) reproducir(tiempoActual()); });
ui.subs.addEventListener('change', () => { estado.subs = ui.subs.checked; if (!rep.sonando) dibujar(rep.offset); });

function mensaje(t, error = false) { ui.msj.textContent = t || ''; ui.msj.classList.toggle('error', !!error); }
function paso(nombre, clase, cuenta) {
  const li = ui.progreso.querySelector(`[data-paso="${nombre}"]`);
  if (!li) return;
  if (clase) { li.classList.remove('activo', 'listo', 'fallo'); li.classList.add(clase); }
  if (cuenta !== undefined) li.querySelector('.cuenta') && (li.querySelector('.cuenta').textContent = cuenta);
}

function aplicarAspecto(a) {
  estado.aspecto = a;
  const [w, h] = TAMANOS[a];
  lienzo.width = w; lienzo.height = h;
  ui.marco.classList.toggle('v916', a === '9:16');
  ui.marco.classList.toggle('v11', a === '1:1');
  document.querySelectorAll('.miniatura').forEach(m => m.style.aspectRatio = a.replace(':', '/'));
  cacheVineta = null;
}

// ---------- Creacion ----------
ui.crear.addEventListener('click', crearHistoria);

async function crearHistoria() {
  const descripcion = ui.desc.value.trim();
  if (descripcion.length < 10) { mensaje('Escribe una descripcion de tu historia (al menos una o dos frases).', true); ui.desc.focus(); return; }

  asegurarAudio(); ac.resume();
  pausar();
  ui.crear.disabled = true; ui.exportar.disabled = true; ui.play.disabled = true; ui.guardar.disabled = true;
  ui.progreso.hidden = false;
  ui.progreso.querySelectorAll('li').forEach(li => { li.className = ''; const c = li.querySelector('.cuenta'); if (c) c.textContent = ''; });
  mensaje('');

  estado.aspecto = ui.aspecto.value;
  estado.idioma = ui.idioma.value;
  estado.lang = ui.idioma.selectedOptions[0].dataset.lang;
  estado.voz = ui.voz.value;
  estado.estilo = ui.estilo.value === 'custom' ? (ui.estiloLibre.value.trim() || 'cinematic digital illustration') : ui.estilo.value;
  estado.musica = ui.musica.checked; estado.subs = ui.subs.checked;
  aplicarAspecto(estado.aspecto);

  try {
    // 1. Guion
    paso('guion', 'activo');
    const guion = await pedirJSON('/api/historia', {
      descripcion, escenas: +ui.num.value, idioma: estado.idioma,
      estilo: ui.estilo.selectedOptions[0].textContent + ' - ' + estado.estilo, publico: ui.publico.value
    });
    estado.guion = guion;
    estado.escenas = guion.escenas.map(e => ({
      narracion: e.narracion || '', prompt_imagen: e.prompt_imagen || e.narracion || '',
      camara: e.camara || 'zoom-in', ambiente: e.ambiente || 'tranquilo', efecto: e.efecto || 'ninguno',
      src: null, img: null, audioB64: null, audioBuf: null, audioTexto: null
    }));
    paso('guion', 'listo');
    pintarTablero();

    // 2. Imagenes
    paso('imagenes', 'activo', `0/${estado.escenas.length}`);
    let hechas = 0;
    const tick = () => paso('imagenes', null, `${++hechas}/${estado.escenas.length}`);
    await generarImagen(0, false); tick();
    const resto = estado.escenas.map((_, i) => i).slice(1);
    await enParalelo(resto, 3, async i => { await generarImagen(i, ui.coherencia.checked); tick(); });
    const fallidas = estado.escenas.filter(e => e.fallo).length;
    paso('imagenes', fallidas ? 'fallo' : 'listo');
    if (fallidas) mensaje(`${fallidas} imagen(es) no se generaron. Puedes reintentar con "Nueva imagen".`, true);

    // 3. Voz
    paso('voz', 'activo');
    await prepararVoz();
    paso('voz', 'listo');

    // 4. Montaje
    paso('montaje', 'activo');
    await montar();
    paso('montaje', 'listo');
    if (!fallidas) mensaje('Listo. Reproduce tu historia o exportala como video.');
    ui.vacio.hidden = true;
    reproducir(0);
  } catch (e) {
    console.error(e);
    ui.progreso.querySelectorAll('li.activo').forEach(li => { li.classList.remove('activo'); li.classList.add('fallo'); });
    mensaje(e.message || 'Ocurrio un error.', true);
  } finally {
    ui.crear.disabled = false;
  }
}

async function generarImagen(i, usarReferencia) {
  const e = estado.escenas[i];
  const tarjeta = ui.tablero.children[i];
  tarjeta?.classList.add('ocupada');
  try {
    const ref = usarReferencia && estado.escenas[0]?.img && !estado.escenas[0].fallo ? miniatura64(estado.escenas[0].img) : null;
    const r = await pedirJSON('/api/imagen', {
      prompt: e.prompt_imagen, estilo: estado.estilo, aspecto: estado.aspecto,
      personajes: estado.guion?.personajes, ambientacion: estado.guion?.ambientacion, referencia: ref
    }, 3);
    e.src = `data:${r.mime};base64,${r.data}`;
    e.img = await cargarImagen(e.src);
    e.fallo = false;
  } catch (err) {
    console.error('Imagen', i, err);
    e.fallo = true;
    e.img = await cargarImagen(imagenRespaldo(i));
    e.src = e.img.src;
  } finally {
    tarjeta?.classList.remove('ocupada');
    refrescarTarjeta(i);
  }
}

function imagenRespaldo(i) {
  const [w, h] = TAMANOS[estado.aspecto];
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const x = c.getContext('2d');
  const gr = x.createLinearGradient(0, 0, w, h);
  gr.addColorStop(0, `hsl(${(i * 47) % 360} 45% 22%)`); gr.addColorStop(1, `hsl(${(i * 47 + 60) % 360} 50% 10%)`);
  x.fillStyle = gr; x.fillRect(0, 0, w, h);
  return c.toDataURL('image/jpeg', 0.9);
}

// ---------- Voz ----------
async function consultarVozIA() {
  if (estado.vozIA !== null) return estado.vozIA;
  try {
    const r = await fetch('/api/voz');
    const j = await r.json();
    estado.vozIA = !!j.disponible;
  } catch { estado.vozIA = false; }
  ui.chipVoz.hidden = false;
  ui.chipVoz.textContent = estado.vozIA ? 'Voz IA activa' : 'Voz del navegador';
  ui.chipVoz.classList.toggle('ok', estado.vozIA);
  return estado.vozIA;
}

async function prepararVoz(soloCambiadas = false) {
  const ia = await consultarVozIA();
  if (!ia) { paso('voz', null, '(voz del navegador)'); return; }
  const pendientes = estado.escenas.map((e, i) => i).filter(i => !soloCambiadas || estado.escenas[i].audioTexto !== estado.escenas[i].narracion);
  let n = 0;
  paso('voz', null, `0/${pendientes.length}`);
  await enParalelo(pendientes, 3, async i => {
    const e = estado.escenas[i];
    if (!e.narracion.trim()) { e.audioBuf = null; e.audioB64 = null; e.audioTexto = e.narracion; return; }
    try {
      const r = await fetch('/api/voz', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ texto: e.narracion, voz: estado.voz, tono: tonoPara(e.ambiente) }) });
      if (!r.ok) throw new Error('voz ' + r.status);
      const buf = await r.arrayBuffer();
      e.audioB64 = b64DeBuffer(buf);
      e.audioBuf = await ac.decodeAudioData(buf.slice(0));
      e.audioTexto = e.narracion;
    } catch (err) { console.error('Voz', i, err); e.audioBuf = null; }
    paso('voz', null, `${++n}/${pendientes.length}`);
  });
}

function tonoPara(ambiente) {
  const m = {
    alegre: 'Narrador de cuentos alegre y luminoso, ritmo vivo.', misterioso: 'Narrador intrigante, voz baja y pausada, con suspenso.',
    tenso: 'Narrador tenso y urgente, frases marcadas.', triste: 'Narrador melancolico y suave, ritmo lento.',
    epico: 'Narrador epico y solemne, con fuerza.', tranquilo: 'Narrador calmado y calido, ritmo pausado.',
    magico: 'Narrador maravillado, tono magico y suave.'
  };
  return m[ambiente] || 'Narrador de cuentos calido y expresivo.';
}

let vocesNav = [];
function cargarVoces() { vocesNav = speechSynthesis.getVoices(); }
if ('speechSynthesis' in window) { cargarVoces(); speechSynthesis.onvoiceschanged = cargarVoces; }
function vozNavegador() {
  const del = vocesNav.filter(v => v.lang.toLowerCase().startsWith(estado.lang));
  return del.find(v => /natural|neural|google|online/i.test(v.name)) || del[0] || null;
}
function hablar(texto) {
  if (!('speechSynthesis' in window) || !texto) return;
  const u = new SpeechSynthesisUtterance(texto);
  const v = vozNavegador(); if (v) u.voice = v;
  u.lang = v?.lang || estado.lang; u.rate = 0.98; u.pitch = 1;
  speechSynthesis.speak(u);
}

// ---------- Montaje (linea de tiempo + musica) ----------
function duracionHabla(e) {
  if (estado.vozIA && e.audioBuf) return e.audioBuf.duration;
  return e.narracion.length / 13.5;
}

function calcularLinea() {
  const clips = [{ tipo: 'intro', inicio: 0, dur: INTRO }];
  let t = INTRO;
  estado.escenas.forEach((e, i) => {
    const habla = duracionHabla(e);
    const dur = Math.max(4.5, habla + PREVOZ + 1.0);
    e.habla = habla;
    clips.push({ tipo: 'escena', i, inicio: t, dur });
    e.inicio = t; e.dur = dur;
    t += dur;
  });
  clips.push({ tipo: 'outro', inicio: t, dur: OUTRO });
  estado.clips = clips;
  estado.duracion = t + OUTRO;
  ui.linea.disabled = false; ui.play.disabled = false; ui.exportar.disabled = false; ui.guardar.disabled = false;
  ui.nota.textContent = estado.vozIA
    ? 'El video incluye imagenes animadas, narracion, musica y subtitulos.'
    : 'La voz del navegador no se graba en el archivo: el video incluye animacion, musica y subtitulos. Activa la voz IA (ver README) para incluir narracion.';
  actualizarTiempo(rep.offset);
}

async function montar() {
  await document.fonts.load('700 40px Fraunces'); await document.fonts.load('600 30px Inter');
  calcularLinea();
  await renderMusica();
  dibujar(0);
}

const MODOS = {
  alegre:     { base: 60, prog: [[0, 'M'], [7, 'M'], [9, 'm'], [5, 'M']], arp: 0.25, filtro: 2400 },
  tranquilo:  { base: 53, prog: [[0, 'M9'], [5, 'M'], [9, 'm'], [7, 's2']], arp: 0.5, filtro: 1500 },
  misterioso: { base: 57, prog: [[0, 'm'], [8, 'M'], [5, 'm'], [7, 's2']], arp: 0, filtro: 800 },
  tenso:      { base: 50, prog: [[0, 'm'], [1, 'M'], [0, 'm'], [7, 'm']], arp: 0.125, filtro: 1000 },
  triste:     { base: 57, prog: [[0, 'm'], [5, 'm'], [8, 'M'], [7, 'm']], arp: 0.5, filtro: 1200 },
  epico:      { base: 50, prog: [[0, 'm'], [8, 'M'], [3, 'M'], [10, 'M']], arp: 0.125, filtro: 2600 },
  magico:     { base: 64, prog: [[0, 'M9'], [2, 'M'], [0, 'M9'], [9, 'm']], arp: 0.25, filtro: 3000 }
};
const INTERVALOS = { M: [0, 4, 7], m: [0, 3, 7], s2: [0, 2, 7], M9: [0, 4, 7, 14] };
const hz = m => 440 * Math.pow(2, (m - 69) / 12);

function modoEn(t) {
  const c = estado.clips.find((c, k) => t >= c.inicio && (k === estado.clips.length - 1 || t < estado.clips[k + 1].inicio));
  if (!c) return 'tranquilo';
  const i = c.tipo === 'intro' ? 0 : c.tipo === 'outro' ? estado.escenas.length - 1 : c.i;
  return MODOS[estado.escenas[i]?.ambiente] ? estado.escenas[i].ambiente : 'tranquilo';
}

async function renderMusica() {
  const firma = estado.escenas.map(e => e.ambiente).join() + '|' + estado.duracion.toFixed(1);
  if (estado.musicaBuffer && firma === estado.musicaFirma) return;
  const sr = 32000, total = estado.duracion + 0.5;
  const off = new OfflineAudioContext(2, Math.ceil(total * sr), sr);
  const salida = off.createGain(); salida.gain.value = 0.9; salida.connect(off.destination);
  salida.gain.setValueAtTime(0.9, Math.max(0, total - 3)); salida.gain.linearRampToValueAtTime(0, total);

  const ACORDE = 4;
  let paso = 0;
  for (let t = 0; t < total; t += ACORDE, paso++) {
    const modo = MODOS[modoEn(t + 0.1)];
    const [grado, cal] = modo.prog[paso % modo.prog.length];
    const raiz = modo.base + grado;
    const filtro = off.createBiquadFilter(); filtro.type = 'lowpass'; filtro.frequency.value = modo.filtro; filtro.Q.value = 0.4;
    filtro.connect(salida);
    // colchon
    INTERVALOS[cal].forEach((iv, k) => {
      [['sine', 0], ['triangle', 6]].forEach(([tipo, desafine]) => {
        const o = off.createOscillator(); o.type = tipo; o.frequency.value = hz(raiz + iv - 12); o.detune.value = desafine * (k % 2 ? 1 : -1);
        const a = off.createGain(); a.gain.setValueAtTime(0, t); a.gain.linearRampToValueAtTime(0.045, t + 1.2);
        a.gain.setValueAtTime(0.045, t + ACORDE - 0.3); a.gain.linearRampToValueAtTime(0, t + ACORDE + 1.2);
        o.connect(a); a.connect(filtro); o.start(t); o.stop(t + ACORDE + 1.3);
      });
    });
    // bajo
    const b = off.createOscillator(); b.type = 'sine'; b.frequency.value = hz(raiz - 24);
    const bg = off.createGain(); bg.gain.setValueAtTime(0, t); bg.gain.linearRampToValueAtTime(0.09, t + 0.4); bg.gain.linearRampToValueAtTime(0, t + ACORDE + 0.4);
    b.connect(bg); bg.connect(salida); b.start(t); b.stop(t + ACORDE + 0.5);
    // arpegio
    if (modo.arp) {
      const notas = INTERVALOS[cal].concat([12]);
      for (let k = 0, s = t; s < t + ACORDE - 0.05; s += modo.arp * 2, k++) {
        const o = off.createOscillator(); o.type = 'sine'; o.frequency.value = hz(raiz + notas[k % notas.length] + 12);
        const a = off.createGain(); a.gain.setValueAtTime(0, s); a.gain.linearRampToValueAtTime(0.028, s + 0.015); a.gain.exponentialRampToValueAtTime(0.0008, s + 0.9);
        o.connect(a); a.connect(filtro); o.start(s); o.stop(s + 1);
      }
    }
  }
  estado.musicaBuffer = await off.startRendering();
  estado.musicaFirma = firma;
}

// ---------- Dibujo ----------
let cacheVineta = null;
function vineta(W, H) {
  if (cacheVineta) return cacheVineta;
  const gr = g.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.35, W / 2, H / 2, Math.hypot(W, H) * 0.62);
  gr.addColorStop(0, 'rgba(0,0,0,0)'); gr.addColorStop(1, 'rgba(0,0,0,0.55)');
  return (cacheVineta = gr);
}

function pintarImagen(img, camara, p) {
  const W = lienzo.width, H = lienzo.height;
  if (!img) { g.fillStyle = '#111'; g.fillRect(0, 0, W, H); return; }
  const iw = img.naturalWidth, ih = img.naturalHeight;
  const base = Math.max(W / iw, H / ih);
  const q = suave(p);
  let esc = base * 1.14, dx = 0, dy = 0;
  if (camara === 'zoom-in') esc = base * (1.04 + 0.16 * q);
  else if (camara === 'zoom-out') esc = base * (1.2 - 0.16 * q);
  const sx = iw * esc - W, sy = ih * esc - H;
  if (camara === 'pan-izquierda') dx = sx * (0.5 - (q - 0.5) * 0.9) - sx / 2;
  if (camara === 'pan-derecha') dx = sx * (0.5 + (q - 0.5) * 0.9) - sx / 2;
  if (camara === 'pan-arriba') dy = sy * (0.5 - (q - 0.5) * 0.9) - sy / 2;
  if (camara === 'pan-abajo') dy = sy * (0.5 + (q - 0.5) * 0.9) - sy / 2;
  const w = iw * esc, h = ih * esc;
  g.drawImage(img, (W - w) / 2 - dx, (H - h) / 2 - dy, w, h);
}

function pintarEfecto(tipo, t, i) {
  if (!tipo || tipo === 'ninguno') return;
  const W = lienzo.width, H = lienzo.height, r = semilla(i * 977 + 13);
  g.save();
  if (tipo === 'particulas') {
    for (let k = 0; k < 70; k++) {
      const x0 = r() * W, y0 = r() * H, v = 8 + r() * 20, rad = 1 + r() * 2.4;
      const x = (x0 + Math.sin(t * 0.6 + k) * 18 + W) % W, y = ((y0 - v * t) % H + H) % H;
      g.fillStyle = `rgba(255,240,215,${0.18 + 0.25 * r()})`; g.beginPath(); g.arc(x, y, rad, 0, 7); g.fill();
    }
  } else if (tipo === 'lluvia') {
    g.strokeStyle = 'rgba(200,215,255,0.32)'; g.lineWidth = 1.4; g.beginPath();
    for (let k = 0; k < 180; k++) {
      const x0 = r() * W, y0 = r() * H, v = 700 + r() * 500, L = 14 + r() * 18;
      const y = (y0 + v * t) % (H + 40) - 20, x = (x0 - y * 0.18 + W * 2) % W;
      g.moveTo(x, y); g.lineTo(x - L * 0.18, y + L);
    }
    g.stroke();
    g.fillStyle = 'rgba(20,30,50,0.18)'; g.fillRect(0, 0, W, H);
  } else if (tipo === 'nieve') {
    for (let k = 0; k < 130; k++) {
      const x0 = r() * W, y0 = r() * H, v = 25 + r() * 45, rad = 1.2 + r() * 2.8;
      const y = (y0 + v * t) % (H + 10), x = (x0 + Math.sin(t * 0.8 + k) * 22 + W) % W;
      g.fillStyle = `rgba(255,255,255,${0.45 + 0.4 * r()})`; g.beginPath(); g.arc(x, y, rad, 0, 7); g.fill();
    }
  } else if (tipo === 'luciernagas') {
    g.globalCompositeOperation = 'lighter';
    for (let k = 0; k < 38; k++) {
      const x0 = r() * W, y0 = r() * H, f = 0.5 + r() * 1.5, rad = 10 + r() * 14;
      const x = x0 + Math.sin(t * 0.5 * f + k) * 40, y = y0 + Math.cos(t * 0.4 * f + k * 2) * 30;
      const a = 0.25 + 0.55 * Math.max(0, Math.sin(t * f * 2 + k * 3));
      const gr = g.createRadialGradient(x, y, 0, x, y, rad);
      gr.addColorStop(0, `rgba(255,236,140,${a})`); gr.addColorStop(1, 'rgba(255,200,80,0)');
      g.fillStyle = gr; g.beginPath(); g.arc(x, y, rad, 0, 7); g.fill();
    }
  } else if (tipo === 'brillo') {
    g.globalCompositeOperation = 'lighter';
    const x = W * (-0.2 + ((t * 0.12) % 1.4)), y = H * 0.25;
    const gr = g.createRadialGradient(x, y, 0, x, y, Math.max(W, H) * 0.6);
    gr.addColorStop(0, 'rgba(255,200,120,0.32)'); gr.addColorStop(1, 'rgba(255,120,60,0)');
    g.fillStyle = gr; g.fillRect(0, 0, W, H);
  }
  g.restore();
}

function lineas(texto, max) {
  const pal = texto.split(/\s+/).filter(Boolean), out = []; let l = '';
  for (const p of pal) { const prueba = l ? l + ' ' + p : p; if (g.measureText(prueba).width > max && l) { out.push(l); l = p; } else l = prueba; }
  if (l) out.push(l);
  return out;
}

function trozos(texto) {
  const frases = texto.match(/[^.!?;]+[.!?;]*\s*/g) || [texto];
  const res = [];
  frases.forEach(f => {
    f = f.trim(); if (!f) return;
    if (f.length <= 110) { res.push(f); return; }
    const pal = f.split(' '); let cur = '';
    pal.forEach(p => { if ((cur + ' ' + p).length > 90 && cur) { res.push(cur); cur = p; } else cur = cur ? cur + ' ' + p : p; });
    if (cur) res.push(cur);
  });
  return res;
}

function pintarSubtitulo(e, t) {
  if (!estado.subs || !e.narracion.trim()) return;
  const W = lienzo.width, H = lienzo.height, base = Math.min(W, H);
  const ini = e.inicio + PREVOZ, hab = Math.max(0.5, e.habla);
  if (t < e.inicio + 0.1 || t > e.inicio + e.dur - 0.25) return;
  const partes = trozos(e.narracion), totalCar = partes.reduce((s, p) => s + p.length, 0);
  const avance = clamp((t - ini) / hab, 0, 1) * totalCar;
  let acc = 0, k = 0;
  for (; k < partes.length - 1; k++) { if (avance < acc + partes[k].length) break; acc += partes[k].length; }
  const frase = partes[k], local = clamp((avance - acc) / frase.length, 0, 1);

  const tam = Math.round(base * (estado.aspecto === '9:16' ? 0.05 : 0.043));
  g.save();
  g.font = `600 ${tam}px Inter, sans-serif`; g.textBaseline = 'middle';
  const ls = lineas(frase, W * 0.82), alto = tam * 1.38;
  const cajaH = ls.length * alto + tam * 0.9;
  const y0 = H * (estado.aspecto === '9:16' ? 0.8 : 0.9) - cajaH;
  const anchoMax = Math.max(...ls.map(l => g.measureText(l).width)) + tam * 1.4;
  g.fillStyle = 'rgba(8,6,10,0.58)';
  const x0 = (W - anchoMax) / 2;
  g.beginPath(); g.roundRect ? g.roundRect(x0, y0, anchoMax, cajaH, tam * 0.45) : g.rect(x0, y0, anchoMax, cajaH); g.fill();
  const palabrasTot = frase.split(/\s+/).length, dichas = Math.ceil(local * palabrasTot);
  let cuenta = 0;
  ls.forEach((l, n) => {
    const pals = l.split(' ');
    let x = (W - g.measureText(l).width) / 2;
    const y = y0 + tam * 0.45 + alto * (n + 0.5);
    pals.forEach(p => {
      g.fillStyle = cuenta < dichas ? '#fff' : 'rgba(255,255,255,0.5)';
      g.fillText(p, x, y); x += g.measureText(p + ' ').width; cuenta++;
    });
  });
  g.restore();
}

function pintarTitulo(texto, sub, alpha) {
  const W = lienzo.width, H = lienzo.height, base = Math.min(W, H);
  g.save(); g.globalAlpha = alpha;
  g.fillStyle = 'rgba(6,4,8,0.55)'; g.fillRect(0, 0, W, H);
  const tam = Math.round(base * 0.095);
  g.font = `700 ${tam}px Fraunces, Georgia, serif`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillStyle = '#fff';
  g.shadowColor = 'rgba(0,0,0,0.6)'; g.shadowBlur = 24;
  const ls = lineas(texto, W * 0.82);
  const y0 = H / 2 - (ls.length - 1) * tam * 0.6;
  ls.forEach((l, k) => g.fillText(l, W / 2, y0 + k * tam * 1.2));
  g.shadowBlur = 0;
  const yl = y0 + (ls.length - 1) * tam * 1.2 + tam * 0.9;
  g.fillStyle = '#f3a83b'; g.fillRect(W / 2 - base * 0.06, yl, base * 0.12, Math.max(3, base * 0.005));
  if (sub) { g.font = `500 ${Math.round(base * 0.034)}px Inter, sans-serif`; g.fillStyle = 'rgba(255,255,255,0.85)'; g.fillText(sub, W / 2, yl + base * 0.06); }
  g.restore();
}

function pintarClip(c, t, alpha) {
  const lt = t - (c.inicio - FUNDIDO), p = lt / (c.dur + 2 * FUNDIDO);
  g.save(); g.globalAlpha = alpha;
  if (c.tipo === 'escena') {
    const e = estado.escenas[c.i];
    pintarImagen(e.img, e.camara, p);
    pintarEfecto(e.efecto, t, c.i);
    g.restore();
    g.save(); g.globalAlpha = alpha; pintarSubtitulo(e, t);
  } else {
    const e = c.tipo === 'intro' ? estado.escenas[0] : estado.escenas[estado.escenas.length - 1];
    pintarImagen(e?.img, c.tipo === 'intro' ? 'zoom-out' : 'zoom-in', p);
    g.restore(); g.save();
    const fade = c.tipo === 'intro' ? clamp(t / 0.8, 0, 1) : clamp((t - c.inicio) / 0.8, 0, 1);
    if (c.tipo === 'intro') pintarTitulo(estado.guion?.titulo || 'Mi historia', '', alpha * fade);
    else pintarTitulo(estado.idioma === 'ingles' ? 'The End' : estado.idioma === 'frances' ? 'Fin' : estado.idioma === 'portugues' ? 'Fim' : 'Fin', estado.guion?.titulo, alpha * fade);
  }
  g.restore();
}

function dibujar(t) {
  const W = lienzo.width, H = lienzo.height;
  g.fillStyle = '#000'; g.fillRect(0, 0, W, H);
  const cl = estado.clips; if (!cl.length) return;
  let k = 0; while (k < cl.length - 1 && t >= cl[k + 1].inicio) k++;
  pintarClip(cl[k], t, 1);
  const sig = cl[k + 1];
  if (sig && t >= sig.inicio - FUNDIDO) pintarClip(sig, t, suave((t - (sig.inicio - FUNDIDO)) / FUNDIDO));
  g.fillStyle = vineta(W, H); g.fillRect(0, 0, W, H);
  // fundido a negro al final
  const fin = estado.duracion;
  if (t > fin - 1) { g.fillStyle = `rgba(0,0,0,${clamp((t - (fin - 1)) / 1, 0, 1)})`; g.fillRect(0, 0, W, H); }
}

// ---------- Reproduccion ----------
const rep = { sonando: false, t0: 0, offset: 0, fuentes: [], hablados: new Set(), raf: 0, exportando: false, alTerminar: null };
const tiempoActual = () => rep.sonando ? ac.currentTime - rep.t0 : rep.offset;

function detenerFuentes() {
  rep.fuentes.forEach(s => { try { s.stop(); } catch {} });
  rep.fuentes = [];
  if ('speechSynthesis' in window) speechSynthesis.cancel();
}

async function reproducir(desde) {
  if (!estado.clips.length) return;
  asegurarAudio(); await ac.resume();
  detenerFuentes(); cancelAnimationFrame(rep.raf);
  rep.offset = clamp(desde ?? rep.offset, 0, estado.duracion);
  if (rep.offset >= estado.duracion - 0.05) rep.offset = 0;
  const ahora = ac.currentTime + 0.05;
  rep.t0 = ahora - rep.offset;

  if (estado.musica && estado.musicaBuffer) {
    const s = ac.createBufferSource(); s.buffer = estado.musicaBuffer; s.connect(busMusica);
    s.start(ahora, rep.offset); rep.fuentes.push(s);
  }
  rep.hablados = new Set();
  estado.escenas.forEach((e, i) => {
    const ini = e.inicio + PREVOZ;
    if (estado.vozIA && e.audioBuf) {
      if (ini + e.audioBuf.duration <= rep.offset) return;
      const s = ac.createBufferSource(); s.buffer = e.audioBuf; s.connect(master);
      s.start(ahora + Math.max(0, ini - rep.offset), Math.max(0, rep.offset - ini)); rep.fuentes.push(s);
    } else if (ini < rep.offset - 0.3) rep.hablados.add(i);
  });

  rep.sonando = true; ui.play.classList.add('sonando'); ui.play.setAttribute('aria-label', 'Pausar');
  bucle();
}

function pausar() {
  if (!rep.sonando) return;
  rep.offset = tiempoActual(); rep.sonando = false;
  detenerFuentes(); cancelAnimationFrame(rep.raf);
  ui.play.classList.remove('sonando'); ui.play.setAttribute('aria-label', 'Reproducir');
  dibujar(rep.offset);
}

function bucle() {
  const t = tiempoActual();
  if (t >= estado.duracion) { terminar(); return; }
  dibujar(Math.max(0, t)); actualizarTiempo(t);
  if (!estado.vozIA && !rep.exportando) {
    estado.escenas.forEach((e, i) => { if (!rep.hablados.has(i) && t >= e.inicio + PREVOZ) { rep.hablados.add(i); hablar(e.narracion); } });
  }
  rep.raf = requestAnimationFrame(bucle);
}

function terminar() {
  rep.sonando = false; detenerFuentes();
  rep.offset = estado.duracion; dibujar(estado.duracion - 0.001); actualizarTiempo(estado.duracion);
  ui.play.classList.remove('sonando');
  if (rep.alTerminar) { const f = rep.alTerminar; rep.alTerminar = null; setTimeout(f, 400); }
}

function actualizarTiempo(t) {
  ui.tiempo.textContent = `${fmt(t)} / ${fmt(estado.duracion)}`;
  if (!rep.arrastrando) ui.linea.value = Math.round((t / (estado.duracion || 1)) * 1000);
  if (rep.exportando) ui.barra.firstElementChild.style.width = `${clamp(t / estado.duracion, 0, 1) * 100}%`;
}

ui.play.addEventListener('click', () => rep.sonando ? pausar() : reproducir());
ui.linea.addEventListener('input', () => {
  if (rep.exportando) return;
  rep.arrastrando = true;
  const t = (ui.linea.value / 1000) * estado.duracion;
  const sonaba = rep.sonando; if (sonaba) pausar();
  rep.offset = t; dibujar(t); actualizarTiempo(t); rep.reanudar = sonaba || rep.reanudar;
});
ui.linea.addEventListener('change', () => { rep.arrastrando = false; if (rep.reanudar) { rep.reanudar = false; reproducir(rep.offset); } });
document.addEventListener('keydown', e => {
  if (e.code === 'Space' && !/TEXTAREA|INPUT|SELECT/.test(document.activeElement.tagName) && estado.clips.length && !rep.exportando) { e.preventDefault(); ui.play.click(); }
});

// ---------- Exportar ----------
function elegirFormato() {
  const opciones = ['video/mp4;codecs=avc1.42E01F,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
  return opciones.find(m => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || '';
}

ui.exportar.addEventListener('click', async () => {
  if (!window.MediaRecorder) { mensaje('Tu navegador no permite grabar video. Usa Chrome, Edge o Safari recientes.', true); return; }
  pausar();
  asegurarAudio(); await ac.resume();
  const mime = elegirFormato();
  const pista = lienzo.captureStream(30);
  const flujo = new MediaStream([...pista.getVideoTracks(), ...destino.stream.getAudioTracks()]);
  const rec = new MediaRecorder(flujo, { mimeType: mime || undefined, videoBitsPerSecond: 8_000_000, audioBitsPerSecond: 160_000 });
  const partes = [];
  rec.ondataavailable = e => e.data.size && partes.push(e.data);
  rec.onstop = () => {
    const tipo = rec.mimeType || mime || 'video/webm';
    const ext = tipo.includes('mp4') ? 'mp4' : 'webm';
    const blob = new Blob(partes, { type: tipo });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `${slug(estado.guion?.titulo)}.${ext}`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
    rep.exportando = false; ui.barra.hidden = true;
    [ui.exportar, ui.crear, ui.play, ui.linea].forEach(b => b.disabled = false);
    mensaje(`Video exportado (${ext.toUpperCase()}, ${(blob.size / 1048576).toFixed(1)} MB).`);
  };
  rep.exportando = true; ui.barra.hidden = false; ui.barra.firstElementChild.style.width = '0';
  [ui.exportar, ui.crear, ui.play, ui.linea].forEach(b => b.disabled = true);
  mensaje('Grabando el video en tiempo real. Mantén esta pestaña abierta y visible hasta que termine.');
  rep.alTerminar = () => rec.stop();
  dibujar(0);
  rec.start(1000);
  await espera(150);
  reproducir(0);
});

// ---------- Tablero de escenas ----------
function pintarTablero() {
  ui.story.hidden = false;
  ui.titulo.textContent = estado.guion?.titulo || 'Escenas';
  ui.sinopsis.textContent = estado.guion?.sinopsis || '';
  ui.tablero.innerHTML = '';
  const tpl = $('#tplEscena');
  estado.escenas.forEach((e, i) => {
    const n = tpl.content.firstElementChild.cloneNode(true);
    n.querySelector('.miniatura').style.aspectRatio = estado.aspecto.replace(':', '/');
    n.querySelector('.num').textContent = `Escena ${i + 1}`;
    const nar = n.querySelector('.narracion'), pr = n.querySelector('.prompt'), cam = n.querySelector('.camara'), ef = n.querySelector('.efecto');
    nar.value = e.narracion; pr.value = e.prompt_imagen; cam.value = e.camara; ef.value = e.efecto;
    nar.addEventListener('input', () => { e.narracion = nar.value; });
    nar.addEventListener('change', () => { if (!estado.vozIA) recalcular(); else mensaje('Pulsa "Regrabar narracion" para actualizar la voz.'); });
    pr.addEventListener('input', () => { e.prompt_imagen = pr.value; });
    cam.addEventListener('change', () => { e.camara = cam.value; if (!rep.sonando) dibujar(rep.offset); });
    ef.addEventListener('change', () => { e.efecto = ef.value; if (!rep.sonando) dibujar(rep.offset); });
    const archivo = n.querySelector('input[type=file]');
    n.querySelector('[data-acc="imagen"]').addEventListener('click', async ev => {
      ev.target.disabled = true; await generarImagen(i, ui.coherencia.checked && i > 0); ev.target.disabled = false; if (!rep.sonando) dibujar(rep.offset);
    });
    n.querySelector('[data-acc="subir"]').addEventListener('click', () => archivo.click());
    archivo.addEventListener('change', () => {
      const f = archivo.files[0]; if (!f) return;
      const lector = new FileReader();
      lector.onload = async () => { e.src = lector.result; e.img = await cargarImagen(e.src); e.fallo = false; refrescarTarjeta(i); if (!rep.sonando) dibujar(rep.offset); };
      lector.readAsDataURL(f); archivo.value = '';
    });
    n.querySelector('[data-acc="ver"]').addEventListener('click', () => { if (estado.clips.length) { reproducir(e.inicio - 0.2); ui.marco.scrollIntoView({ behavior: 'smooth', block: 'center' }); } });
    ui.tablero.appendChild(n);
    refrescarTarjeta(i);
  });
}

function refrescarTarjeta(i) {
  const n = ui.tablero.children[i]; if (!n) return;
  const im = n.querySelector('img');
  if (estado.escenas[i].src) im.src = estado.escenas[i].src; else im.removeAttribute('src');
}

async function recalcular() {
  const t = rep.offset; const sonaba = rep.sonando; pausar();
  calcularLinea(); await renderMusica();
  rep.offset = clamp(t, 0, estado.duracion); dibujar(rep.offset);
  if (sonaba) reproducir(rep.offset);
}

ui.revoz.addEventListener('click', async () => {
  if (!estado.escenas.length) return;
  ui.revoz.disabled = true; mensaje('Actualizando la narracion...');
  pausar();
  await prepararVoz(true);
  await recalcular();
  ui.revoz.disabled = false; mensaje('Narracion actualizada.');
});

// ---------- Guardar / abrir proyecto ----------
ui.guardar.addEventListener('click', () => {
  const datos = {
    version: 1, guion: { ...estado.guion, escenas: undefined },
    ajustes: { aspecto: estado.aspecto, idioma: estado.idioma, lang: estado.lang, voz: estado.voz, estilo: estado.estilo, musica: estado.musica, subs: estado.subs },
    escenas: estado.escenas.map(e => ({ narracion: e.narracion, prompt_imagen: e.prompt_imagen, camara: e.camara, ambiente: e.ambiente, efecto: e.efecto, src: e.src, audioB64: e.audioB64, audioTexto: e.audioTexto }))
  };
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(datos)], { type: 'application/json' }));
  a.download = `${slug(estado.guion?.titulo)}.historia.json`; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 30_000);
});

ui.cargar.addEventListener('click', () => ui.archivo.click());
ui.archivo.addEventListener('change', async () => {
  const f = ui.archivo.files[0]; if (!f) return; ui.archivo.value = '';
  try {
    asegurarAudio(); pausar();
    const d = JSON.parse(await f.text());
    Object.assign(estado, d.ajustes);
    ui.aspecto.value = estado.aspecto; ui.idioma.value = estado.idioma; ui.voz.value = estado.voz; ui.musica.checked = estado.musica; ui.subs.checked = estado.subs;
    aplicarAspecto(estado.aspecto);
    estado.guion = d.guion; estado.musicaBuffer = null;
    estado.escenas = await Promise.all(d.escenas.map(async e => {
      const img = e.src ? await cargarImagen(e.src) : null;
      let audioBuf = null;
      if (e.audioB64) { try { audioBuf = await ac.decodeAudioData(bufferDeB64(e.audioB64)); } catch {} }
      return { ...e, img, audioBuf };
    }));
    await consultarVozIA();
    if (!estado.vozIA && estado.escenas.some(e => e.audioBuf)) { estado.vozIA = true; ui.chipVoz.textContent = 'Voz IA (guardada)'; ui.chipVoz.classList.add('ok'); }
    pintarTablero(); await montar(); ui.vacio.hidden = true; rep.offset = 0;
    mensaje('Proyecto abierto.');
  } catch (e) { console.error(e); mensaje('No se pudo abrir el proyecto: ' + e.message, true); }
});

aplicarAspecto('16:9');
})();
