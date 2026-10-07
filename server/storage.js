// File storage: Vercel Blob when BLOB_READ_WRITE_TOKEN is set, otherwise local disk.
// The stored key is what goes in the DB; files are only ever served through the authenticated API.
// Note: Vercel Blob URLs are unguessable but not access-controlled. For production with real customer
// data, prefer a private bucket (S3 ap-south-1 with SSE-KMS) behind the same three functions.
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';

const root = path.resolve(config.dataDir, 'files');

function localPath(key) {
  const full = path.resolve(root, key);
  if (!full.startsWith(root + path.sep)) throw new Error('Invalid storage key');
  return full;
}

/** Stores the file and returns the key to save in the DB. */
export async function putFile(key, buffer, contentType) {
  if (config.blobToken) {
    const { put } = await import('@vercel/blob');
    const blob = await put(key, buffer, {
      access: 'public', addRandomSuffix: true, contentType, token: config.blobToken,
    });
    return blob.url;
  }
  const full = localPath(key);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, buffer);
  return key;
}

export async function getFile(key) {
  if (key.startsWith('https://')) {
    const res = await fetch(key);
    if (!res.ok) throw new Error(`Blob fetch ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }
  return fs.readFile(localPath(key));
}

export async function deletePrefix(prefix) {
  if (config.blobToken) {
    const { list, del } = await import('@vercel/blob');
    let cursor;
    do {
      const page = await list({ prefix: `${prefix}/`, cursor, token: config.blobToken });
      if (page.blobs.length) await del(page.blobs.map((b) => b.url), { token: config.blobToken });
      cursor = page.hasMore ? page.cursor : undefined;
    } while (cursor);
  }
  await fs.rm(localPath(prefix), { recursive: true, force: true }).catch(() => {});
}
