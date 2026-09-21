/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { createReadStream } from 'fs';
import fs from 'fs/promises';
import path from 'path';

import { isAdmin as isAdminFn } from '../security.js';
import logger from '../../services/logger.js';
import * as listingStorage from '../../services/storage/listingsStorage.js';
import { getSettings } from '../../services/storage/settingsStorage.js';
import {
  archivedMediaFilename,
  archivedMediaLocalPath,
  deleteArchivedMedia,
  getArchivedMedia,
  listArchivedMedia,
} from '../../services/listings/listingArchive.js';

const NO_ACCESS_MESSAGE = 'You are trying to access a listing that is not associated to your user';
const INLINE_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif']);

/**
 * Authorize a read or mutation against archived provider media.
 *
 * @param {import('fastify').FastifyRequest} request
 * @param {import('fastify').FastifyReply} reply
 * @param {boolean} writing
 * @returns {Promise<{listingId: string}|null>}
 */
async function authorize(request, reply, writing) {
  const listingId = request.params?.listingId;
  const userId = request.session?.currentUser;
  if (!listingId || !userId) {
    reply.code(400).send({ message: 'listingId or user not provided' });
    return null;
  }
  if (!listingStorage.userCanAccessListing(listingId, userId, isAdminFn(request))) {
    reply.code(403).send({ message: NO_ACCESS_MESSAGE });
    return null;
  }

  if (writing) {
    const settings = await getSettings();
    if (settings?.demoMode === true && !isAdminFn(request)) {
      reply.code(403).send({ message: 'Archived provider documents cannot be deleted in demo mode' });
      return null;
    }
  }
  return { listingId };
}

/**
 * Serve archived provider images and documents without exposing their filesystem paths.
 *
 * Deletion is limited to provider attachments; images belong to the read-only listing gallery.
 * Deleting a document removes its archived bytes and media row while retaining the raw capture.
 *
 * @param {import('fastify').FastifyInstance} fastify
 */
export default async function listingArchiveMediaPlugin(fastify) {
  fastify.get('/:listingId/media', async (request, reply) => {
    const scope = await authorize(request, reply, false);
    if (scope == null) return reply;

    try {
      return reply.send({ media: listArchivedMedia(scope.listingId) });
    } catch (error) {
      logger.error(error);
      return reply.code(500).send({ message: 'Failed to load archived provider media' });
    }
  });

  fastify.get('/:listingId/media/:mediaId', async (request, reply) => {
    const scope = await authorize(request, reply, false);
    if (scope == null) return reply;

    try {
      const media = getArchivedMedia(request.params?.mediaId, scope.listingId);
      if (media == null) return reply.code(404).send({ message: 'Archived provider media not found' });

      const localPath = archivedMediaLocalPath(media);
      const [realRoot, realPath] = await Promise.all([fs.realpath(media.mediaRoot), fs.realpath(localPath)]);
      if (!realPath.startsWith(realRoot + path.sep)) {
        return reply.code(404).send({ message: 'Archived provider media not found' });
      }
      const stats = await fs.stat(localPath);
      if (!stats.isFile()) return reply.code(404).send({ message: 'Archived provider media not found' });

      // Provider Content-Type headers are untrusted. Never render active content such as SVG/HTML
      // inline on Fredy's origin; unknown formats are downloads with a restrictive CSP.
      const disposition = media.kind === 'image' && INLINE_IMAGE_TYPES.has(media.contentType) ? 'inline' : 'attachment';
      const filename = archivedMediaFilename(media);
      reply.header('Content-Type', media.contentType || 'application/octet-stream');
      reply.header('Content-Length', stats.size);
      reply.header('X-Content-Type-Options', 'nosniff');
      reply.header('Content-Security-Policy', "sandbox; default-src 'none'");
      reply.header('Cache-Control', 'private, no-store');
      reply.header('Content-Disposition', `${disposition}; filename*=UTF-8''${encodeURIComponent(filename)}`);
      return reply.send(createReadStream(localPath));
    } catch (error) {
      if (error?.code === 'ENOENT') {
        return reply.code(404).send({ message: 'Archived provider media not found' });
      }
      logger.error(error);
      return reply.code(500).send({ message: 'Failed to load archived provider media' });
    }
  });

  fastify.delete('/:listingId/media/:mediaId', async (request, reply) => {
    const scope = await authorize(request, reply, true);
    if (scope == null) return reply;

    try {
      const media = getArchivedMedia(request.params?.mediaId, scope.listingId);
      if (media == null) return reply.code(404).send({ message: 'Archived provider media not found' });
      if (media.kind !== 'attachment') {
        return reply.code(400).send({ message: 'Only archived provider documents can be deleted' });
      }

      const deleted = await deleteArchivedMedia(media.id, scope.listingId);
      if (!deleted) return reply.code(404).send({ message: 'Archived provider media not found' });
      return reply.send({ deleted: true });
    } catch (error) {
      logger.error(error);
      return reply.code(500).send({ message: 'Failed to delete archived provider document' });
    }
  });
}
