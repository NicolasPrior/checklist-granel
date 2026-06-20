/*
 * dulcini-core.js - Nucleo compartilhado dos checklists Dulcini (granel + fracionado).
 * Contem o MOTOR DE OCR dos lacres: pre-processamento (limiar adaptativo), geracao de
 * variantes, votacao por consenso, gate de seguranca (nunca preenche errado) e o melhor
 * palpite ("leitura provavel" para confirmacao manual).
 *
 * FONTE UNICA: edite este arquivo em shared/ e rode `node tools/sync-shared.mjs` para
 * copiar para checklist-granel/ e checklist-fracionado/. Cada index.html o carrega via
 * <script src="dulcini-core.js"> ANTES do script principal (compartilham o escopo global).
 */

// ===== Constantes e estado do OCR =====
const OCR_SCRIPT_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';
const OCR_LACRE_NAO_IDENTIFICADO = 'Lacre não identificado';
const OCR_CONFIDENCE_MIN = 58;
const OCR_CONFIDENCE_ALTA = 90;
const OCR_OCORRENCIAS_MIN = 2;
const OCR_AMBIGUITY_GAP_MIN = 10;
const OCR_LACRE_TAMANHO_MIN = 7;
const OCR_LACRE_TAMANHO_PREFERENCIAL = 7;
const OCR_LACRE_TAMANHO_MAX = 7;
const OCR_LACRE_PREFIXO_PADRAO = /^0{2,}/;
let ocrScriptPromise = null;
let ocrWorkerPromise = null;

// ===== Motor de leitura dos lacres =====
function registrarFalhaOCR(contexto, motivo, detalhes = {}) {
  console.warn('OCR do lacre não identificado:', { contexto, motivo, ...detalhes });
}

function carregarBibliotecaOCR() {
  if (window.Tesseract) return Promise.resolve(window.Tesseract);
  if (ocrScriptPromise) return ocrScriptPromise;

  ocrScriptPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    const timeout = setTimeout(() => {
      reject(new Error('Tempo limite excedido ao carregar a biblioteca de OCR.'));
    }, 20000);

    script.src = OCR_SCRIPT_URL;
    script.async = true;
    script.onload = () => {
      clearTimeout(timeout);
      if (window.Tesseract) resolve(window.Tesseract);
      else reject(new Error('Biblioteca de OCR carregada sem objeto Tesseract.'));
    };
    script.onerror = () => {
      clearTimeout(timeout);
      reject(new Error('Falha ao carregar a biblioteca de OCR.'));
    };

    document.head.appendChild(script);
  });

  return ocrScriptPromise;
}

async function obterWorkerOCR() {
  if (ocrWorkerPromise) return ocrWorkerPromise;

  ocrWorkerPromise = (async () => {
    const tesseract = await carregarBibliotecaOCR();
    if (!tesseract?.createWorker) {
      throw new Error('A biblioteca de OCR não disponibilizou o worker.');
    }

    const worker = await tesseract.createWorker('eng');
    if (worker.setParameters) {
      await worker.setParameters({
        tessedit_char_whitelist: '0123456789',
        preserve_interword_spaces: '1',
        classify_bln_numeric_mode: '1',
        tessedit_pageseg_mode: '7',
        user_defined_dpi: '420'
      });
    }
    return worker;
  })();

  return ocrWorkerPromise;
}

async function encerrarWorkerOCR() {
  if (!ocrWorkerPromise) return;

  try {
    const worker = await ocrWorkerPromise;
    if (worker?.terminate) await worker.terminate();
  } catch (erro) {
    console.warn('Falha ao encerrar o worker de OCR:', erro);
  } finally {
    ocrWorkerPromise = null;
  }
}

function limparNumeroLacreOCR(valor = '') {
  const substituicoes = { O: '0', o: '0', I: '1', l: '1', '|': '1', S: '5', s: '5', B: '8' };
  return String(valor || '')
    .replace(/[OoIl|SsB]/g, (caractere) => substituicoes[caractere] || caractere)
    .replace(/\D+/g, '');
}

function calcularConfiancaOCR(dados = {}, numero = '') {
  const base = Number(dados.confidence || 0);
  const palavras = Array.isArray(dados.words) ? dados.words : [];
  const confiancas = palavras
    .filter((palavra) => {
      const digitos = limparNumeroLacreOCR(palavra?.text || '');
      return digitos && (digitos === numero || numero.includes(digitos) || digitos.includes(numero));
    })
    .map((palavra) => Number(palavra.confidence || 0))
    .filter((valor) => Number.isFinite(valor) && valor > 0);

  return confiancas.length ? Math.max(Number.isFinite(base) ? base : 0, ...confiancas) : (Number.isFinite(base) ? base : 0);
}

function registrarCandidatoLacreOCR(mapa, numero, confianca = 0, origem = 'OCR') {
  const digitos = limparNumeroLacreOCR(numero);
  if (digitos.length < OCR_LACRE_TAMANHO_MIN || digitos.length > OCR_LACRE_TAMANHO_MAX) return;

  const atual = mapa.get(digitos) || {
    numero: digitos,
    confiancaBase: 0,
    ocorrencias: 0,
    origens: new Set()
  };

  atual.confiancaBase = Math.max(atual.confiancaBase, Number(confianca || 0));
  atual.ocorrencias += 1;
  atual.origens.add(origem);
  mapa.set(digitos, atual);
}

function ordenarCandidatosLacreOCR(mapa) {
  return Array.from(mapa.values())
    .map((candidato) => {
      const bonusComprimento = candidato.numero.length === OCR_LACRE_TAMANHO_PREFERENCIAL ? 14 : 4;
      const bonusZeros = OCR_LACRE_PREFIXO_PADRAO.test(candidato.numero) ? 12 : 0;
      const bonusOcorrencias = Math.min(14, Math.max(0, candidato.ocorrencias - 1) * 5);
      const bonusPreprocessamento = Array.from(candidato.origens).some((origem) => origem !== 'foto original') ? 5 : 0;
      const confianca = Math.min(100, candidato.confiancaBase + bonusComprimento + bonusZeros + bonusOcorrencias + bonusPreprocessamento);

      return {
        numero: candidato.numero,
        confianca,
        ocorrencias: candidato.ocorrencias,
        origens: Array.from(candidato.origens)
      };
    })
    .sort((a, b) => b.confianca - a.confianca || b.ocorrencias - a.ocorrencias || b.numero.length - a.numero.length);
}

function extrairCandidatosNumeroLacre(dados = {}, origem = 'foto original') {
  const texto = String(dados.text || '');
  const mapa = new Map();
  const textoNormalizado = texto.replace(/[Oo]/g, '0').replace(/[Il|]/g, '1').replace(/[Ss]/g, '5').replace(/B/g, '8');
  const linhas = textoNormalizado.split(/\n+/).map((linha) => linha.trim()).filter(Boolean);

  const registrarTrecho = (trecho) => {
    const numero = limparNumeroLacreOCR(trecho);
    if (!numero) return;

    if (numero.length > OCR_LACRE_TAMANHO_MAX) {
      const padraoComZeros = new RegExp('0{2,}\\d{' + (OCR_LACRE_TAMANHO_MIN - 2) + ',' + (OCR_LACRE_TAMANHO_MAX - 2) + '}', 'g');
      const padraoGenerico = new RegExp('\\d{' + OCR_LACRE_TAMANHO_PREFERENCIAL + '}', 'g');
      const candidatos = numero.match(padraoComZeros) || numero.match(padraoGenerico) || [];
      candidatos.forEach((candidato) => registrarCandidatoLacreOCR(mapa, candidato, calcularConfiancaOCR(dados, candidato), origem));
      return;
    }

    registrarCandidatoLacreOCR(mapa, numero, calcularConfiancaOCR(dados, numero), origem);
  };

  linhas.forEach((linha) => {
    const encontrados = linha.match(/[0-9][0-9\s.\-_/]{4,}[0-9]/g) || [];
    encontrados.forEach(registrarTrecho);
  });

  (Array.isArray(dados.words) ? dados.words : []).forEach((palavra) => {
    const numero = limparNumeroLacreOCR(palavra?.text || '');
    registrarCandidatoLacreOCR(mapa, numero, Number(palavra?.confidence || 0), origem);
  });

  return ordenarCandidatosLacreOCR(mapa);
}

function carregarImagemOCR(src) {
  return new Promise((resolve, reject) => {
    const imagem = new Image();
    imagem.onload = () => resolve(imagem);
    imagem.onerror = () => reject(new Error('Não foi possível carregar a imagem para OCR.'));
    imagem.src = src;
  });
}

function calcularRecorteOCR(imagem, recorte) {
  const larguraNatural = imagem.naturalWidth || imagem.width;
  const alturaNatural = imagem.naturalHeight || imagem.height;
  const xInicial = Math.max(0, Math.min(0.995, Number(recorte.x || 0)));
  const yInicial = Math.max(0, Math.min(0.995, Number(recorte.y || 0)));
  const largura = Math.max(0.005, Math.min(1 - xInicial, Number(recorte.w || 1)));
  const altura = Math.max(0.005, Math.min(1 - yInicial, Number(recorte.h || 1)));

  return {
    x: Math.max(0, Math.round(larguraNatural * xInicial)),
    y: Math.max(0, Math.round(alturaNatural * yInicial)),
    w: Math.max(1, Math.round(larguraNatural * largura)),
    h: Math.max(1, Math.round(alturaNatural * altura))
  };
}

function limitarRecorteOCR(recorte) {
  const x = Math.max(0, Math.min(0.995, Number(recorte.x || 0)));
  const y = Math.max(0, Math.min(0.995, Number(recorte.y || 0)));
  return {
    ...recorte,
    x,
    y,
    w: Math.max(0.005, Math.min(1 - x, Number(recorte.w || 1))),
    h: Math.max(0.005, Math.min(1 - y, Number(recorte.h || 1)))
  };
}

function expandirRecorteOCR(recorte, margemX = 0.04, margemY = 0.08) {
  return limitarRecorteOCR({
    ...recorte,
    x: recorte.x - margemX,
    y: recorte.y - margemY,
    w: recorte.w + (margemX * 2),
    h: recorte.h + (margemY * 2)
  });
}

function pixelAzulLacreOCR(r, g, b) {
  const maximo = Math.max(r, g, b);
  const minimo = Math.min(r, g, b);
  const saturacao = maximo === 0 ? 0 : (maximo - minimo) / maximo;
  return b > 78
    && b >= r * 1.16
    && b >= g * 0.86
    && (b - r) > 24
    && saturacao > 0.18;
}

function detectarRecortesLacreAzulOCR(imagem) {
  const larguraNatural = imagem.naturalWidth || imagem.width;
  const alturaNatural = imagem.naturalHeight || imagem.height;
  const escala = Math.min(1, 920 / Math.max(larguraNatural, alturaNatural));
  const largura = Math.max(1, Math.round(larguraNatural * escala));
  const altura = Math.max(1, Math.round(alturaNatural * escala));
  const canvas = document.createElement('canvas');
  canvas.width = largura;
  canvas.height = altura;

  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(imagem, 0, 0, largura, altura);

  const dados = ctx.getImageData(0, 0, largura, altura).data;
  const tamanho = largura * altura;
  const mascara = new Uint8Array(tamanho);
  const visitado = new Uint8Array(tamanho);

  for (let i = 0, p = 0; i < dados.length; i += 4, p += 1) {
    if (pixelAzulLacreOCR(dados[i], dados[i + 1], dados[i + 2])) {
      mascara[p] = 1;
    }
  }

  const componentes = [];
  const fila = [];
  const minimoPixels = Math.max(36, Math.round(tamanho * 0.00025));

  for (let indice = 0; indice < tamanho; indice += 1) {
    if (!mascara[indice] || visitado[indice]) continue;

    let inicio = 0;
    let fim = 0;
    let total = 0;
    let minX = largura;
    let minY = altura;
    let maxX = 0;
    let maxY = 0;

    fila[fim++] = indice;
    visitado[indice] = 1;

    while (inicio < fim) {
      const atual = fila[inicio++];
      const x = atual % largura;
      const y = Math.floor(atual / largura);

      total += 1;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;

      const vizinhos = [atual - 1, atual + 1, atual - largura, atual + largura];
      for (const vizinho of vizinhos) {
        if (vizinho < 0 || vizinho >= tamanho || visitado[vizinho] || !mascara[vizinho]) continue;
        if ((atual % largura === 0 && vizinho === atual - 1) || (atual % largura === largura - 1 && vizinho === atual + 1)) continue;
        visitado[vizinho] = 1;
        fila[fim++] = vizinho;
      }
    }

    const larguraBox = maxX - minX + 1;
    const alturaBox = maxY - minY + 1;
    const proporcao = larguraBox / Math.max(1, alturaBox);
    if (total >= minimoPixels && proporcao >= 1.15 && larguraBox > 28 && alturaBox > 10) {
      componentes.push({ total, minX, minY, maxX, maxY, larguraBox, alturaBox, proporcao });
    }
  }

  return componentes
    .sort((a, b) => b.total - a.total)
    .slice(0, 4)
    .flatMap((componente, indice) => {
      const base = expandirRecorteOCR({
        nome: indice === 0 ? 'lacre azul detectado' : 'lacre azul detectado alternativo',
        x: componente.minX / largura,
        y: componente.minY / altura,
        w: componente.larguraBox / largura,
        h: componente.alturaBox / altura
      }, 0.018, 0.035);

      const leituraAmpla = limitarRecorteOCR({
        nome: base.nome + ' - leitura ampla',
        x: base.x + (base.w * 0.02),
        y: base.y + (base.h * 0.12),
        w: base.w * 0.72,
        h: base.h * 0.78,
        modo: 'digitos-claros',
        psm: '6'
      });

      const faixaNumero = limitarRecorteOCR({
        nome: base.nome + ' - faixa da numeracao',
        x: base.x + (base.w * 0.02),
        y: base.y + (base.h * 0.34),
        w: base.w * 0.62,
        h: base.h * 0.48,
        modo: 'digitos-claros',
        psm: '7'
      });

      const faixaInferior = limitarRecorteOCR({
        nome: base.nome + ' - faixa inferior',
        x: base.x,
        y: base.y + (base.h * 0.45),
        w: base.w * 0.66,
        h: base.h * 0.42,
        modo: 'limiar-adaptativo',
        psm: '7'
      });

      const numeroDulcini = limitarRecorteOCR({
        nome: base.nome + ' - numero Dulcini',
        x: base.x + (base.w * 0.035),
        y: base.y + (base.h * 0.39),
        w: base.w * 0.48,
        h: base.h * 0.32,
        modo: 'digitos-claros',
        psm: '7',
        alvoLargura: 2500,
        escalaMax: 8
      });

      const numeroDulciniEstreito = limitarRecorteOCR({
        nome: base.nome + ' - numero Dulcini estreito',
        x: base.x + (base.w * 0.04),
        y: base.y + (base.h * 0.46),
        w: base.w * 0.45,
        h: base.h * 0.24,
        modo: 'limiar-adaptativo',
        psm: '8',
        alvoLargura: 2600,
        escalaMax: 8
      });

      const numeroDulciniRealcado = limitarRecorteOCR({
        nome: base.nome + ' - numero Dulcini realcado',
        x: base.x + (base.w * 0.10),
        y: base.y + (base.h * 0.37),
        w: base.w * 0.50,
        h: base.h * 0.34,
        modo: 'realce-branco',
        psm: '7',
        alvoLargura: 2800,
        escalaMax: 8
      });

      const numeroDulciniCentral = limitarRecorteOCR({
        nome: base.nome + ' - numero Dulcini central',
        x: base.x + (base.w * 0.12),
        y: base.y + (base.h * 0.41),
        w: base.w * 0.46,
        h: base.h * 0.28,
        modo: 'realce-branco',
        psm: '8',
        alvoLargura: 2800,
        escalaMax: 8
      });

      const numeroDulciniLinhaBaixa = limitarRecorteOCR({
        nome: base.nome + ' - numero Dulcini linha baixa',
        x: base.x + (base.w * 0.08),
        y: base.y + (base.h * 0.43),
        w: base.w * 0.54,
        h: base.h * 0.28,
        modo: 'realce-branco',
        psm: '7',
        alvoLargura: 2900,
        escalaMax: 8
      });

      return [
        { ...base, modo: 'alto-contraste', psm: '6', alvoLargura: 1900, escalaMax: 4 },
        leituraAmpla,
        faixaNumero,
        faixaInferior,
        numeroDulcini,
        numeroDulciniEstreito,
        numeroDulciniRealcado,
        numeroDulciniCentral,
        numeroDulciniLinhaBaixa
      ];
    });
}

// Os lacres Dulcini tem numeracao CLARA em BAIXO-RELEVO sobre fundo azul: o numero e apenas
// um pouco mais claro que o fundo, com baixo contraste e iluminacao irregular. Limiar global
// (a abordagem antiga de "texto branco") apaga os digitos. Aqui usamos LIMIAR ADAPTATIVO LOCAL
// (imagem integral) para isolar pixels mais claros que a propria vizinhanca, corrigindo a
// iluminacao irregular e entregando texto preto em fundo branco para o Tesseract. O `modo` so
// ajusta o offset, criando variacoes uteis para a votacao entre variantes.
function offsetLimiarOCR(modo) {
  if (modo === 'limiar-adaptativo') return 2;
  if (modo === 'realce-branco') return 12;
  if (modo === 'alto-contraste') return -2;
  return 7; // digitos-claros / padrao
}

function criarImagemPreprocessadaOCR(imagem, recorte, modo = 'digitos-claros') {
  const area = calcularRecorteOCR(imagem, recorte);
  const alvoLargura = recorte.alvoLargura || (area.w < 900 ? 2300 : 1850);
  const escala = Math.min(recorte.escalaMax || 6, Math.max(1.35, alvoLargura / area.w));
  const canvas = document.createElement('canvas');
  const largura = canvas.width = Math.round(area.w * escala);
  const altura = canvas.height = Math.round(area.h * escala);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(imagem, area.x, area.y, area.w, area.h, 0, 0, largura, altura);

  const imagemData = ctx.getImageData(0, 0, largura, altura);
  const pixels = imagemData.data;
  const total = largura * altura;

  const cinza = new Float32Array(total);
  for (let i = 0, p = 0; i < pixels.length; i += 4, p += 1) {
    cinza[p] = (pixels[i] * 0.299) + (pixels[i + 1] * 0.587) + (pixels[i + 2] * 0.114);
  }

  // Imagem integral (soma de prefixos) para media local em O(1) por pixel.
  const larguraI = largura + 1;
  const integral = new Float64Array(larguraI * (altura + 1));
  for (let y = 0; y < altura; y += 1) {
    let somaLinha = 0;
    for (let x = 0; x < largura; x += 1) {
      somaLinha += cinza[y * largura + x];
      integral[(y + 1) * larguraI + (x + 1)] = integral[y * larguraI + (x + 1)] + somaLinha;
    }
  }

  const raio = Math.max(10, Math.round(altura * 0.18));
  const offset = offsetLimiarOCR(modo);

  for (let y = 0; y < altura; y += 1) {
    const y0 = Math.max(0, y - raio);
    const y1 = Math.min(altura - 1, y + raio);
    for (let x = 0; x < largura; x += 1) {
      const x0 = Math.max(0, x - raio);
      const x1 = Math.min(largura - 1, x + raio);
      const areaJanela = (x1 - x0 + 1) * (y1 - y0 + 1);
      const soma = integral[(y1 + 1) * larguraI + (x1 + 1)]
        - integral[y0 * larguraI + (x1 + 1)]
        - integral[(y1 + 1) * larguraI + x0]
        + integral[y0 * larguraI + x0];
      const media = soma / areaJanela;
      // Texto claro: pixel mais brilhante que a vizinhanca vira tinta preta (0).
      const valor = cinza[y * largura + x] > media + offset ? 0 : 255;
      const idx = (y * largura + x) * 4;
      pixels[idx] = pixels[idx + 1] = pixels[idx + 2] = valor;
      pixels[idx + 3] = 255;
    }
  }

  ctx.putImageData(imagemData, 0, 0);
  return canvas.toDataURL('image/png');
}

async function gerarVariantesOCR(src) {
  const imagem = await carregarImagemOCR(src);
  const recortesDetectados = detectarRecortesLacreAzulOCR(imagem);
  const recortesFallback = [
    { nome: 'foto completa numeracao esparsa', x: 0.00, y: 0.00, w: 1.00, h: 1.00, modo: 'digitos-claros', psm: '11', alvoLargura: 2000, escalaMax: 2.6 },
    { nome: 'foto completa numeracao bloco', x: 0.00, y: 0.00, w: 1.00, h: 1.00, modo: 'limiar-adaptativo', psm: '6', alvoLargura: 2000, escalaMax: 2.6 },
    { nome: 'metade inferior numeracao esparsa', x: 0.00, y: 0.30, w: 1.00, h: 0.70, modo: 'digitos-claros', psm: '11', alvoLargura: 2200, escalaMax: 4 },
    { nome: 'faixa central da numeracao', x: 0.03, y: 0.26, w: 0.82, h: 0.42, modo: 'digitos-claros', psm: '7' },
    { nome: 'area esquerda da numeracao', x: 0.00, y: 0.32, w: 0.76, h: 0.38, modo: 'limiar-adaptativo', psm: '7' },
    { nome: 'faixa inferior da numeracao', x: 0.00, y: 0.44, w: 0.80, h: 0.38, modo: 'realce-branco', psm: '7' }
  ];

  const variantes = [{ nome: 'foto original', src, psm: '6' }];
  const chaves = new Set();

  [...recortesDetectados, ...recortesFallback].forEach((recorte) => {
    const normalizado = limitarRecorteOCR(recorte);
    const chave = [normalizado.x, normalizado.y, normalizado.w, normalizado.h, normalizado.modo]
      .map((valor) => Number.isFinite(Number(valor)) ? Number(valor).toFixed(3) : String(valor || ''))
      .join('|');
    if (chaves.has(chave)) return;
    chaves.add(chave);
    variantes.push({
      nome: normalizado.nome,
      psm: normalizado.psm || '7',
      src: criarImagemPreprocessadaOCR(imagem, normalizado, normalizado.modo)
    });
  });

  return variantes;
}

async function configurarWorkerOCRParaVariante(worker, psm) {
  if (!worker?.setParameters) return;

  await worker.setParameters({
    tessedit_char_whitelist: '0123456789',
    classify_bln_numeric_mode: '1',
    preserve_interword_spaces: '1',
    tessedit_pageseg_mode: String(psm || '7'),
    user_defined_dpi: '420'
  });
}

function candidatoConcorrenteOCRRelevante(principal, candidato) {
  if (!principal || !candidato) return false;

  const candidatoExpandidoPorRuido = candidato.numero.includes(principal.numero)
    && candidato.numero !== principal.numero
    && principal.numero.length === OCR_LACRE_TAMANHO_PREFERENCIAL
    && principal.ocorrencias >= 2
    && candidato.ocorrencias <= 1;

  if (candidatoExpandidoPorRuido) return false;
  return true;
}

function numeroLacreSeguePadraoDulcini(numero = '') {
  const digitos = limparNumeroLacreOCR(numero);
  // Lacres Dulcini tem 7 digitos. O prefixo "00" e comum, mas NAO obrigatorio (existem
  // lacres sem zeros a esquerda), entao ele entra como reforco de ranqueamento, nao como regra.
  return digitos.length === OCR_LACRE_TAMANHO_PREFERENCIAL;
}

function origemOCRAuxiliar(origem = '') {
  return /realcado|central|linha baixa/i.test(String(origem || ''));
}

function candidatoTemOrigemForte(candidato) {
  return Boolean(candidato?.origens?.some((origem) => origem && origem !== 'foto original' && !origemOCRAuxiliar(origem)));
}

function resultadoOCRConfiavel(principal, segundo) {
  if (!principal) return false;
  if (!numeroLacreSeguePadraoDulcini(principal.numero)) return false;

  // Ambiguidade: dois numeros validos diferentes com confianca proxima -> nao preenche
  // automaticamente (vai para confirmacao manual). Evita gravar o numero errado.
  const segundoValido = segundo && numeroLacreSeguePadraoDulcini(segundo.numero) ? segundo : null;
  if (segundoValido && (principal.confianca - segundoValido.confianca) < OCR_AMBIGUITY_GAP_MIN) return false;

  // Auto-preenche apenas com sinal MUITO forte de acerto: confianca alta E consenso entre
  // variantes independentes E sem ambiguidade. Em baixa resolucao, leituras de confianca
  // media podem estar erradas (ex.: "8" lido como "9"); essas vao para confirmacao manual,
  // nunca preenchem automaticamente. A origem e o prefixo "00" sao reforcos, nunca vetos.
  return principal.confianca >= OCR_CONFIDENCE_ALTA && principal.ocorrencias >= OCR_OCORRENCIAS_MIN;
}

async function identificarNumeroLacreNaFoto(src, contexto) {
  if (!src) {
    registrarFalhaOCR(contexto, 'foto ausente');
    return { identificado: false, numero: '', confianca: 0 };
  }

  try {
    const worker = await obterWorkerOCR();
    const variantes = await gerarVariantesOCR(src);
    const mapaCandidatos = new Map();
    const textos = [];
    let psmAtual = '';

    for (const variante of variantes) {
      if (variante.psm !== psmAtual) {
        await configurarWorkerOCRParaVariante(worker, variante.psm);
        psmAtual = variante.psm;
      }

      const resultado = await worker.recognize(variante.src);
      const dados = resultado?.data || {};
      textos.push({ variante: variante.nome, psm: variante.psm, texto: dados.text || '', confianca: Number(dados.confidence || 0) });

      extrairCandidatosNumeroLacre(dados, variante.nome).forEach((candidato) => {
        registrarCandidatoLacreOCR(mapaCandidatos, candidato.numero, candidato.confianca, variante.nome);
      });
    }

    const candidatos = ordenarCandidatosLacreOCR(mapaCandidatos);
    const principal = candidatos[0];

    if (!principal) {
      registrarFalhaOCR(contexto, 'nenhum candidato numerico encontrado', { textos });
      return { identificado: false, numero: '', confianca: 0 };
    }

    const segundo = candidatos.find((candidato) => (
      candidato.numero !== principal.numero
      && numeroLacreSeguePadraoDulcini(candidato.numero)
      && candidatoConcorrenteOCRRelevante(principal, candidato)
    ));
    // Melhor palpite (mesmo sem certeza): so sugere se tiver o formato de lacre (7 digitos).
    // Vai para a UI como "leitura provavel - confira", SEM preencher o campo automaticamente.
    const sugestao = numeroLacreSeguePadraoDulcini(principal.numero) ? principal.numero : '';

    if (!resultadoOCRConfiavel(principal, segundo)) {
      registrarFalhaOCR(contexto, segundo ? 'resultado ambiguo ou abaixo do limite' : 'confianca abaixo do limite', { principal, segundo, textos });
      return { identificado: false, numero: '', confianca: principal.confianca, sugestao, sugestaoConfianca: principal.confianca };
    }

    return {
      identificado: true,
      numero: principal.numero,
      confianca: principal.confianca,
      sugestao: principal.numero,
      sugestaoConfianca: principal.confianca
    };
  } catch (erro) {
    registrarFalhaOCR(contexto, 'falha tecnica no OCR', { erro });
    return { identificado: false, numero: '', confianca: 0 };
  }
}

// ===== Preparacao da imagem para OCR (PNG sem perdas) =====
// Versao SEM PERDAS (PNG) para o OCR, redimensionada para um tamanho util sem artefatos.
function prepararImagemOCR(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (evento) => {
      const img = new Image();
      img.onload = () => {
        const maxLado = 2400;
        const escala = Math.min(1, maxLado / Math.max(img.width, img.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(img.width * escala));
        canvas.height = Math.max(1, Math.round(img.height * escala));
        const ctx = canvas.getContext('2d');
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/png'));
      };
      img.onerror = reject;
      img.src = evento.target.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}
