/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { mkdtemp, rm, writeFile, symlink } from 'fs/promises';
import os from 'os';
import path from 'path';

vi.mock('../../lib/services/listings/listingArchive.js', () => ({
  archivedMediaFilename: (media) => media.filename,
  archivedMediaLocalPath: (media) => path.join(media.mediaRoot, media.relativePath),
  deleteArchivedMedia: vi.fn(async () => true),
  getArchivedMedia: vi.fn(),
  listArchivedMedia: vi.fn(() => []),
}));
vi.mock('../../lib/services/storage/listingsStorage.js', () => ({ userCanAccessListing: vi.fn(() => true) }));
vi.mock('../../lib/services/storage/settingsStorage.js', () => ({
  getSettings: vi.fn(async () => ({ demoMode: false })),
}));
vi.mock('../../lib/services/logger.js', () => ({ default: { error: vi.fn() } }));
vi.mock('../../lib/api/security.js', () => ({ isAdmin: vi.fn(() => false) }));

import { deleteArchivedMedia, getArchivedMedia } from '../../lib/services/listings/listingArchive.js';
import { userCanAccessListing } from '../../lib/services/storage/listingsStorage.js';
import { getSettings } from '../../lib/services/storage/settingsStorage.js';
import { isAdmin } from '../../lib/api/security.js';
import plugin from '../../lib/api/routes/listingArchiveMediaRouter.js';

let app;
let directory;
let media;
beforeEach(async () => {
  vi.clearAllMocks();
  directory = await mkdtemp(path.join(os.tmpdir(), 'fredy-media-route-'));
  await writeFile(path.join(directory, 'file'), 'archived bytes');
  media = {
    id: 'media-1',
    kind: 'attachment',
    filename: 'expose.pdf',
    contentType: 'application/pdf',
    mediaRoot: directory,
    relativePath: 'file',
  };
  getArchivedMedia.mockImplementation(() => media);
  deleteArchivedMedia.mockResolvedValue(true);
  userCanAccessListing.mockReturnValue(true);
  getSettings.mockResolvedValue({ demoMode: false });
  isAdmin.mockReturnValue(false);
  app = Fastify();
  app.addHook('onRequest', async (request) => {
    request.session = { currentUser: 'user-1' };
  });
  await app.register(plugin);
});
afterEach(async () => {
  await app.close();
  await rm(directory, { recursive: true, force: true });
});

describe('archived provider media API', () => {
  it('streams documents as downloads and raster images inline', async () => {
    let response = await app.inject('/listing-1/media/media-1');
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('archived bytes');
    expect(response.headers['content-disposition']).toContain('attachment;');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(getArchivedMedia).toHaveBeenCalledWith('media-1', 'listing-1');
    media.kind = 'image';
    media.contentType = 'image/jpeg';
    response = await app.inject('/listing-1/media/media-1');
    expect(response.headers['content-disposition']).toContain('inline;');
    expect(response.headers['content-type']).toBe('image/jpeg');
    media.contentType = 'image/svg+xml';
    response = await app.inject('/listing-1/media/media-1');
    expect(response.headers['content-disposition']).toContain('attachment;');
    expect(response.headers['content-security-policy']).toContain('sandbox');
  });

  it.each(['GET', 'DELETE'])('denies %s for inaccessible listings before touching media', async (method) => {
    userCanAccessListing.mockReturnValue(false);
    expect((await app.inject({ method, url: '/listing-1/media/media-1' })).statusCode).toBe(403);
    expect(getArchivedMedia).not.toHaveBeenCalled();
    expect(deleteArchivedMedia).not.toHaveBeenCalled();
    expect((await app.inject('/listing-1/media')).statusCode).toBe(403);
  });

  it('deletes only provider documents and enforces demo mode', async () => {
    const remove = () => app.inject({ method: 'DELETE', url: '/listing-1/media/media-1' });
    getSettings.mockResolvedValue({ demoMode: true });
    expect((await remove()).statusCode).toBe(403);
    expect(deleteArchivedMedia).not.toHaveBeenCalled();
    isAdmin.mockReturnValue(true);
    expect((await remove()).json()).toEqual({ deleted: true });
    expect(deleteArchivedMedia).toHaveBeenCalledWith('media-1', 'listing-1');
    deleteArchivedMedia.mockClear();
    media.kind = 'image';
    expect((await remove()).statusCode).toBe(400);
    expect(deleteArchivedMedia).not.toHaveBeenCalled();
  });

  it('returns 404 for missing files, unknown IDs and symlinks outside the media root', async () => {
    media.relativePath = 'missing';
    expect((await app.inject('/listing-1/media/media-1')).statusCode).toBe(404);
    media.relativePath = 'escape';
    await symlink(import.meta.filename, path.join(directory, 'escape'));
    expect((await app.inject('/listing-1/media/media-1')).statusCode).toBe(404);
    getArchivedMedia.mockReturnValue(null);
    expect((await app.inject('/listing-1/media/media-1')).statusCode).toBe(404);
    expect((await app.inject({ method: 'DELETE', url: '/listing-1/media/media-1' })).statusCode).toBe(404);
  });
});
