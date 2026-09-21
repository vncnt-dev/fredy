/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { nanoid } from 'nanoid';
import logger from '../logger.js';
import { isPubliclyFetchableUrl } from '../security/outboundUrl.js';
import SqliteConnection, { computeDbPath } from '../storage/SqliteConnection.js';
import { getSettings } from '../storage/settingsStorage.js';
import { DEFAULT_LISTING_MEDIA_ROOT } from '../storage/migrations/sql/45.internal-listing-archive.js';
import { sanitizeAttachmentName } from './attachmentTypes.js';

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

const ARCHIVED_MEDIA_COLUMNS = `id,
  listing_id AS listingId,
  kind,
  source_url AS sourceUrl,
  final_url AS finalUrl,
  media_root AS mediaRoot,
  relative_path AS relativePath,
  content_type AS contentType,
  size_bytes AS sizeBytes,
  status,
  created_at AS createdAt`;

/**
 * Resolve the configured media root. Relative values live beside listings.db, which keeps source
 * checkouts portable and makes the default land on Fredy's persisted `/db` volume in Docker.
 *
 * @param {string|null|undefined} configuredRoot
 * @returns {Promise<string>}
 */
export async function resolveListingMediaRoot(configuredRoot) {
  const { dir } = await computeDbPath();
  const configured = String(configuredRoot ?? DEFAULT_LISTING_MEDIA_ROOT).trim() || DEFAULT_LISTING_MEDIA_ROOT;
  return path.isAbsolute(configured) ? path.resolve(configured) : path.resolve(dir, configured);
}

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

/**
 * Download one provider-owned media item into the configured archive.
 *
 * Errors are returned as metadata rather than thrown so one broken gallery image cannot prevent the
 * capture, the other downloads or the user's normal notification.
 *
 * @param {Object} params
 * @param {string} params.sourceUrl
 * @param {string} params.baseUrl
 * @param {'image'|'attachment'} params.kind
 * @param {string} params.mediaRoot
 * @param {string} params.provider
 * @param {string} params.jobKey
 * @param {string} params.listingId
 * @param {typeof fetch} [params.fetchImpl]
 * @returns {Promise<Object>}
 */
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
    const root = path.resolve(mediaRoot);
    const directory = path.resolve(root, safeSegment(provider), safeSegment(jobKey), safeSegment(listingId));
    if (!directory.startsWith(root + path.sep)) throw new Error('Generated media path escapes media root');

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

/**
 * Persist the provider capture and archive all media for listings that survived the pipeline.
 *
 * @param {Object} params
 * @param {Object[]} params.listings
 * @param {string} params.provider
 * @param {string} params.jobId
 * @param {typeof fetch} [params.fetchImpl]
 * @returns {Promise<Object[]>} The same listing array for pipeline chaining.
 */
export async function archiveListings({ listings, provider, jobId, fetchImpl = fetch }) {
  if (!Array.isArray(listings) || listings.length === 0) return listings;
  const settings = await getSettings();
  const mediaRoot = await resolveListingMediaRoot(settings?.listingMediaRoot);

  for (const listing of listings) {
    try {
      await archiveListing({ listing, provider, jobId, mediaRoot, fetchImpl });
    } catch (error) {
      logger.warn(`Could not archive listing '${listing?.id ?? ''}'`, error);
    }
  }
  return listings;
}

async function archiveListing({ listing, provider, jobId, mediaRoot, fetchImpl }) {
  const now = Date.now();
  const rawResponse = listing.rawResponse ?? {
    search: { format: 'json', contentType: 'application/json', body: listing },
    detail: null,
    detailStatus: 'unsupported',
  };
  const candidates = [...new Set(listing.images ?? [listing.image].filter(Boolean))].map((sourceUrl) => ({
    kind: 'image',
    sourceUrl,
  }));
  candidates.push(...[...new Set(listing.attachments ?? [])].map((sourceUrl) => ({ kind: 'attachment', sourceUrl })));

  const mediaRows = SqliteConnection.withTransaction((db) => {
    db.prepare(
      `INSERT INTO listing_archive (listing_id, raw_response, archived_at)
       VALUES (@listingId, @rawResponse, @archivedAt)
       ON CONFLICT(listing_id) DO UPDATE SET
         raw_response = excluded.raw_response,
         archived_at = excluded.archived_at`,
    ).run({ listingId: listing.id, rawResponse: JSON.stringify(rawResponse), archivedAt: now });

    const insert = db.prepare(
      `INSERT INTO listing_archive_media (
         id, listing_id, kind, source_url, media_root, status, created_at, updated_at
       ) VALUES (
         @id, @listingId, @kind, @sourceUrl, @mediaRoot, 'pending', @now, @now
       )
       ON CONFLICT(listing_id, kind, source_url) DO NOTHING`,
    );
    const find = db.prepare(
      `SELECT id, kind, source_url AS sourceUrl, status
       FROM listing_archive_media
       WHERE listing_id = @listingId AND kind = @kind AND source_url = @sourceUrl`,
    );
    return candidates.map((candidate) => {
      insert.run({ id: nanoid(), listingId: listing.id, mediaRoot, now, ...candidate });
      return find.get({ listingId: listing.id, ...candidate });
    });
  });

  for (const media of mediaRows.filter((row) => row.status !== 'stored')) {
    const archived = await archiveMediaItem({
      sourceUrl: media.sourceUrl,
      baseUrl: listing.link,
      kind: media.kind,
      mediaRoot,
      provider,
      jobKey: jobId,
      listingId: listing.id,
      fetchImpl,
    });
    const relativePath = archived.localPath ? path.relative(mediaRoot, archived.localPath) : null;
    try {
      SqliteConnection.execute(
        `UPDATE listing_archive_media
         SET final_url = @finalUrl,
             media_root = @mediaRoot,
             relative_path = @relativePath,
             content_type = @contentType,
             size_bytes = @sizeBytes,
             sha256 = @sha256,
             status = @status,
             error = @error,
             updated_at = @updatedAt
         WHERE id = @id`,
        {
          id: media.id,
          finalUrl: archived.finalUrl ?? null,
          mediaRoot,
          relativePath,
          contentType: archived.contentType ?? null,
          sizeBytes: archived.sizeBytes ?? null,
          sha256: archived.sha256 ?? null,
          status: archived.status,
          error: archived.error ?? null,
          updatedAt: Date.now(),
        },
      );
    } catch (error) {
      if (archived.localPath) await fs.unlink(archived.localPath).catch(() => {});
      throw error;
    }
  }
}

/**
 * A stable, human-readable name for archived media.
 *
 * Provider URLs quite often end in a useful filename. When they do not, the content type supplies
 * the extension and the row id keeps multiple unnamed files distinct.
 *
 * @param {{id: string, kind: string, sourceUrl?: string|null, finalUrl?: string|null, contentType?: string|null}} media
 * @returns {string}
 */
export function archivedMediaFilename(media) {
  for (const candidate of [media.finalUrl, media.sourceUrl]) {
    if (!candidate) continue;
    try {
      const basename = decodeURIComponent(new URL(candidate).pathname.split('/').pop() ?? '').trim();
      if (basename && basename !== '.' && basename !== '..') return sanitizeAttachmentName(basename, media.contentType);
    } catch {
      // A malformed source URL should not make otherwise valid archived bytes inaccessible.
    }
  }
  const extension = MIME_EXTENSIONS[media.contentType] ?? '';
  return `${media.kind === 'image' ? 'image' : 'document'}-${media.id}${extension}`;
}

/**
 * Stored provider media for a listing, without internal filesystem paths or source URLs.
 *
 * Only completed downloads are returned. Pending and failed rows describe no bytes the browser
 * could display, and exposing their errors here would leak provider implementation detail.
 *
 * @param {string} listingId
 * @returns {Array<{id: string, listingId: string, kind: string, filename: string, contentType: string|null, sizeBytes: number|null, createdAt: number}>}
 */
export function listArchivedMedia(listingId) {
  if (!listingId) return [];
  return SqliteConnection.query(
    `SELECT ${ARCHIVED_MEDIA_COLUMNS}
     FROM listing_archive_media
     WHERE listing_id = @listingId
       AND status = 'stored'
       AND relative_path IS NOT NULL
     ORDER BY created_at ASC, rowid ASC`,
    { listingId },
  ).map((media) => ({
    id: media.id,
    listingId: media.listingId,
    kind: media.kind,
    filename: archivedMediaFilename(media),
    contentType: media.contentType,
    sizeBytes: media.sizeBytes,
    createdAt: media.createdAt,
  }));
}

/**
 * One archived provider media row including the private path needed to serve its bytes.
 *
 * @param {string} mediaId
 * @param {string} listingId
 * @returns {Object|null}
 */
export function getArchivedMedia(mediaId, listingId) {
  if (!mediaId || !listingId) return null;
  const rows = SqliteConnection.query(
    `SELECT ${ARCHIVED_MEDIA_COLUMNS}
     FROM listing_archive_media
     WHERE id = @mediaId
       AND listing_id = @listingId
       AND status = 'stored'
       AND relative_path IS NOT NULL
     LIMIT 1`,
    { mediaId, listingId },
  );
  return rows[0] ?? null;
}

/**
 * Resolve an archived media path while enforcing that it remains below the root stored with it.
 *
 * @param {{mediaRoot: string, relativePath: string}} media
 * @returns {string}
 */
export function archivedMediaLocalPath(media) {
  const root = path.resolve(media.mediaRoot);
  const localPath = path.resolve(root, media.relativePath);
  if (!localPath.startsWith(root + path.sep)) throw new Error('Archived media path escapes its media root');
  return localPath;
}

/**
 * Delete one archived provider file and its metadata while deliberately retaining raw_response.
 *
 * The database row goes first so its trigger records a durable cleanup job. The file is removed
 * immediately when possible; an unlink failure leaves the queue row for the cleanup cron to retry.
 * Nothing touches `listing_archive`, whose raw capture remains the immutable source record.
 *
 * @param {string} mediaId
 * @param {string} listingId
 * @returns {Promise<boolean>} Whether a stored media row existed and was deleted.
 */
export async function deleteArchivedMedia(mediaId, listingId) {
  const media = getArchivedMedia(mediaId, listingId);
  if (media == null) return false;
  const result = SqliteConnection.execute(
    `DELETE FROM listing_archive_media WHERE id = @mediaId AND listing_id = @listingId`,
    { mediaId, listingId },
  );
  if ((result?.changes ?? 0) === 0) return false;
  await cleanQueuedArchiveFile(media);
  return true;
}

/**
 * Remove files queued by the archive tables' delete trigger.
 *
 * A row is removed only after the file is gone. Failed unlinks remain queued for the next run,
 * while an already missing file counts as cleaned. Stored roots make cleanup independent of later
 * changes to the `listingMediaRoot` setting.
 *
 * @param {{limit?: number}} [options]
 * @returns {Promise<number>} Number of queue rows cleared.
 */
export async function drainListingArchiveCleanup({ limit = 500 } = {}) {
  const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 500;
  const rows = SqliteConnection.query(
    `SELECT media_root AS mediaRoot, relative_path AS relativePath
     FROM listing_archive_cleanup
     ORDER BY queued_at
     LIMIT ${safeLimit}`,
  );
  let cleaned = 0;

  for (const row of rows) {
    if (await cleanQueuedArchiveFile(row)) cleaned += 1;
  }
  return cleaned;
}

async function cleanQueuedArchiveFile(row) {
  const root = path.resolve(row.mediaRoot);
  let localPath;
  try {
    localPath = archivedMediaLocalPath(row);
  } catch {
    localPath = path.resolve(root, row.relativePath);
    logger.warn(`Refusing to remove archive path outside its media root: ${localPath}`);
    removeCleanupRow(row);
    return true;
  }
  try {
    await fs.unlink(localPath);
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      logger.warn(`Could not remove archived media '${localPath}'`, error);
      return false;
    }
  }
  await removeEmptyParents(path.dirname(localPath), root);
  removeCleanupRow(row);
  return true;
}

function removeCleanupRow(row) {
  SqliteConnection.execute(
    `DELETE FROM listing_archive_cleanup
     WHERE media_root = @mediaRoot AND relative_path = @relativePath`,
    row,
  );
}

async function removeEmptyParents(directory, root) {
  let current = path.resolve(directory);
  while (current !== root && current.startsWith(root + path.sep)) {
    try {
      await fs.rmdir(current);
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTEMPTY') {
        logger.debug(`Could not remove empty archive directory '${current}'`, error);
      }
      return;
    }
    current = path.dirname(current);
  }
}
