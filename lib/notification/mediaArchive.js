/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { isPubliclyFetchableUrl } from '../services/security/outboundUrl.js';

const MAX_REDIRECTS = 5;
const DOWNLOAD_TIMEOUT_MS = 30_000;
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;

const MIME_EXTENSIONS = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/avif': '.avif',
  'application/pdf': '.pdf',
  'application/msword': '.doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.oasis.opendocument.text': '.odt',
};

function safeSegment(value) {
  return String(value ?? 'unknown')
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^\.+$/, '_')
    .slice(0, 160);
}

function downloadUrl(rawUrl, baseUrl) {
  const absolute = new URL(rawUrl, baseUrl).toString();
  return absolute.replaceAll('%WIDTH%', '1920').replaceAll('%HEIGHT%', '1080');
}

async function fetchFollowingSafeRedirects(rawUrl, fetchImpl) {
  let current = rawUrl;
  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
    if (!isPubliclyFetchableUrl(current)) throw new Error('URL is not publicly fetchable');
    const response = await fetchImpl(current, {
      redirect: 'manual',
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) throw new Error(`Redirect ${response.status} has no Location header`);
      current = new URL(location, current).toString();
      continue;
    }
    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`.trim());
    return { response, finalUrl: current };
  }
  throw new Error(`More than ${MAX_REDIRECTS} redirects`);
}

function validateContentType(kind, contentType) {
  if (kind === 'image' && !contentType.startsWith('image/')) {
    throw new Error(`Expected an image but received "${contentType || 'unknown'}"`);
  }
  if (kind === 'attachment' && (contentType === 'text/html' || contentType.startsWith('image/'))) {
    throw new Error(`Expected a document but received "${contentType || 'unknown'}"`);
  }
}

export async function archiveMediaItem(params) {
  const { sourceUrl, baseUrl, kind, mediaRoot, provider, jobKey, listingId, fetchImpl = fetch } = params;
  try {
    const requestedUrl = downloadUrl(sourceUrl, baseUrl);
    const { response, finalUrl } = await fetchFollowingSafeRedirects(requestedUrl, fetchImpl);
    const contentType = (response.headers.get('content-type') ?? '').split(';', 1)[0].trim().toLowerCase();
    validateContentType(kind, contentType);

    const maxBytes = kind === 'image' ? MAX_IMAGE_BYTES : MAX_ATTACHMENT_BYTES;
    const declaredBytes = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredBytes) && declaredBytes > maxBytes) {
      throw new Error(`File exceeds ${maxBytes} byte limit`);
    }

    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > maxBytes) throw new Error(`File exceeds ${maxBytes} byte limit`);

    const urlHash = crypto.createHash('sha256').update(sourceUrl).digest('hex');
    const contentHash = crypto.createHash('sha256').update(bytes).digest('hex');
    const extension = MIME_EXTENSIONS[contentType] ?? '';
    const directory = path.resolve(mediaRoot, safeSegment(provider), safeSegment(jobKey), safeSegment(listingId));
    const root = path.resolve(mediaRoot);
    if (directory !== root && !directory.startsWith(root + path.sep)) {
      throw new Error('Generated media path escapes media root');
    }

    await fs.mkdir(directory, { recursive: true });
    const localPath = path.join(directory, `${urlHash}${extension}`);
    const temporaryPath = `${localPath}.tmp-${process.pid}-${crypto.randomUUID()}`;
    await fs.writeFile(temporaryPath, bytes, { flag: 'wx' });
    await fs.rename(temporaryPath, localPath);

    return {
      sourceUrl,
      finalUrl,
      localPath,
      contentType,
      sizeBytes: bytes.length,
      sha256: contentHash,
      status: 'stored',
    };
  } catch (error) {
    return { sourceUrl, status: 'failed', error: error?.message ?? String(error) };
  }
}

export async function archiveListingMedia(params) {
  const common = {
    baseUrl: params.baseUrl,
    mediaRoot: params.mediaRoot,
    provider: params.provider,
    jobKey: params.jobKey,
    listingId: params.listingId,
    fetchImpl: params.fetchImpl,
  };
  const images = [];
  for (const sourceUrl of [...new Set(params.images ?? [])]) {
    images.push(await archiveMediaItem({ ...common, sourceUrl, kind: 'image' }));
  }
  const attachments = [];
  for (const sourceUrl of [...new Set(params.attachments ?? [])]) {
    attachments.push(await archiveMediaItem({ ...common, sourceUrl, kind: 'attachment' }));
  }
  return { images, attachments };
}
