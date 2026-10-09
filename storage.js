'use strict';
// Upload d'images / vidéos vers ImageKit
const crypto = require('crypto');
const path = require('path');
const multer = require('multer');
const ImageKit = require('imagekit');
const cfg = require('./config');
const { HttpError, bad } = require('./utils');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: cfg.maxUploadMb * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) =>
    /^(image\/(jpeg|png|webp|gif)|video\/(mp4|webm|quicktime))$/i.test(file.mimetype)
      ? cb(null, true)
      : cb(new HttpError(415, 'Type de fichier non autorisé.'))
});

let client;
function getClient() {
  const { publicKey, privateKey, urlEndpoint } = cfg.imagekit;
  if (!publicKey || !privateKey || !urlEndpoint) {
    bad(503, 'ImageKit pa konfigire: mete IMAGEKIT_PUBLIC_KEY, IMAGEKIT_PRIVATE_KEY ak IMAGEKIT_URL_ENDPOINT nan Render Environment.');
  }
  if (!client) client = new ImageKit({ publicKey, privateKey, urlEndpoint });
  return client;
}

const cleanFolder = f => String(f || 'uploads').replace(/[^a-zA-Z0-9_-]/g, '-');

async function uploadFile(file, folder) {
  if (!file || !file.buffer) bad(400, 'Fichier manquant.');
  const ik = getClient();
  const ext = path.extname(String(file.originalname || '')).replace(/[^.a-zA-Z0-9]/g, '').slice(0, 12);
  try {
    const r = await ik.upload({
      file: file.buffer,
      fileName: crypto.randomUUID() + ext,
      folder: '/flex-tupup/' + cleanFolder(folder),
      useUniqueFileName: false,
      tags: ['flex-tupup', cleanFolder(folder)]
    });
    if (!r || !r.url) throw new Error('Pas d’URL retournée');
    return { url: r.url, fileId: r.fileId, name: r.name };
  } catch (e) {
    console.error('[ImageKit]', e.message);
    if (e instanceof HttpError) throw e;
    throw new HttpError(502, 'ImageKit pa rive telechaje fichye a. Verifye kle API yo, limit kont lan, epi gade Render Logs.');
  }
}

/* data:image/...;base64,... => URL ImageKit */
async function uploadDataUrl(dataUrl, folder) {
  const m = String(dataUrl || '').match(/^data:(image\/(?:jpeg|png|webp|gif));base64,([A-Za-z0-9+/=]+)$/i);
  if (!m) bad(400, 'Fòma foto a pa valab.');
  const ext = m[1].toLowerCase() === 'image/jpeg' ? '.jpg' : '.' + m[1].split('/')[1];
  return uploadFile({ buffer: Buffer.from(m[2], 'base64'), mimetype: m[1], originalname: 'upload' + ext }, folder);
}

/* Si la valeur est une image base64, l'envoyer sur ImageKit ; sinon la garder telle quelle */
async function resolveImage(value, folder) {
  const v = String(value == null ? '' : value).trim();
  if (/^data:image\//i.test(v)) return (await uploadDataUrl(v, folder)).url;
  return v.slice(0, 2000);
}

module.exports = { upload, uploadFile, uploadDataUrl, resolveImage };
