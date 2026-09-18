/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { mkdtemp, readFile, rm } from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { archiveListingMedia, archiveMediaItem } from '../../lib/notification/mediaArchive.js';

const temporaryDirectories = [];

async function temporaryDirectory() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'fredy-media-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('media archive', () => {
  it('stores unique images and documents below the listing directory', async () => {
    const mediaRoot = await temporaryDirectory();
    const fetchImpl = async (url) =>
      new Response(url.includes('pdf') ? 'document' : 'image', {
        headers: { 'content-type': url.includes('pdf') ? 'application/pdf' : 'image/jpeg' },
      });

    const archived = await archiveListingMedia({
      images: ['https://cdn.example/image.jpg', 'https://cdn.example/image.jpg'],
      attachments: ['https://cdn.example/expose.pdf'],
      baseUrl: 'https://portal.example/listing/1',
      mediaRoot,
      provider: 'provider',
      jobKey: 'job',
      listingId: '../listing',
      fetchImpl,
    });

    expect(archived.images).toHaveLength(1);
    expect(archived.attachments).toHaveLength(1);
    expect(archived.images[0].status).toBe('stored');
    expect(archived.images[0].localPath.startsWith(mediaRoot)).toBe(true);
    expect(await readFile(archived.images[0].localPath, 'utf8')).toBe('image');
  });

  it('records unsafe and invalid downloads instead of throwing', async () => {
    const mediaRoot = await temporaryDirectory();
    const result = await archiveMediaItem({
      sourceUrl: 'http://127.0.0.1/private.jpg',
      baseUrl: 'https://portal.example/listing/1',
      kind: 'image',
      mediaRoot,
      provider: 'provider',
      jobKey: 'job',
      listingId: 'listing',
      fetchImpl: async () => {
        throw new Error('must not be called');
      },
    });

    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/publicly fetchable/);
  });
});
