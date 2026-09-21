/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtemp, readFile, rm } from 'fs/promises';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

describe('internal listing archive', () => {
  let db;
  let mediaBase;
  let archiveListings;
  let archiveMediaItem;
  let drainListingArchiveCleanup;
  let deleteArchivedMedia;
  let listArchivedMedia;
  let getArchivedMedia;
  let archivedMediaLocalPath;

  beforeEach(async () => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(`
      CREATE TABLE listings (id TEXT PRIMARY KEY);
      CREATE TABLE listing_archive (
        listing_id TEXT PRIMARY KEY REFERENCES listings(id) ON DELETE CASCADE,
        raw_response TEXT NOT NULL,
        archived_at INTEGER NOT NULL
      );
      CREATE TABLE listing_archive_media (
        id TEXT PRIMARY KEY,
        listing_id TEXT NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        source_url TEXT NOT NULL,
        final_url TEXT,
        media_root TEXT NOT NULL,
        relative_path TEXT,
        content_type TEXT,
        size_bytes INTEGER,
        sha256 TEXT,
        status TEXT NOT NULL,
        error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE (listing_id, kind, source_url)
      );
      CREATE TABLE listing_archive_cleanup (
        media_root TEXT NOT NULL,
        relative_path TEXT NOT NULL,
        queued_at INTEGER NOT NULL,
        PRIMARY KEY (media_root, relative_path)
      );
      CREATE TRIGGER queue_listing_archive_media_cleanup
      AFTER DELETE ON listing_archive_media
      WHEN OLD.relative_path IS NOT NULL
      BEGIN
        INSERT OR IGNORE INTO listing_archive_cleanup (media_root, relative_path, queued_at)
        VALUES (OLD.media_root, OLD.relative_path, 1);
      END;
    `);
    mediaBase = await mkdtemp(path.join(os.tmpdir(), 'fredy-listing-archive-'));

    vi.resetModules();
    vi.doMock('../../../lib/services/storage/SqliteConnection.js', () => ({
      default: {
        query: (sql, params) => (params === undefined ? db.prepare(sql).all() : db.prepare(sql).all(params)),
        execute: (sql, params) => db.prepare(sql).run(params),
        withTransaction: (callback) => db.transaction(callback)(db),
      },
      computeDbPath: async () => ({ dir: mediaBase, dbPath: path.join(mediaBase, 'listings.db') }),
    }));
    vi.doMock('../../../lib/services/storage/settingsStorage.js', () => ({
      getSettings: async () => ({ listingMediaRoot: 'listing-media' }),
    }));

    ({
      archiveListings,
      archiveMediaItem,
      drainListingArchiveCleanup,
      deleteArchivedMedia,
      listArchivedMedia,
      getArchivedMedia,
      archivedMediaLocalPath,
    } = await import('../../../lib/services/listings/listingArchive.js'));
  });

  afterEach(async () => {
    db.close();
    await rm(mediaBase, { recursive: true, force: true });
    vi.doUnmock('../../../lib/services/storage/SqliteConnection.js');
    vi.doUnmock('../../../lib/services/storage/settingsStorage.js');
  });

  it('stores the raw provider response, downloads unique media and cleans it after cascade deletion', async () => {
    db.prepare(`INSERT INTO listings (id) VALUES ('listing-1')`).run();
    const listing = {
      id: 'listing-1',
      link: 'https://portal.example/listing-1',
      image: 'https://cdn.example/one.jpg',
      images: ['https://cdn.example/one.jpg', 'https://cdn.example/one.jpg'],
      attachments: ['https://cdn.example/expose.pdf'],
      rawResponse: {
        search: { format: 'json', contentType: 'application/json', body: { sourceId: 1 } },
        detail: null,
        detailStatus: 'disabled',
      },
    };
    const fetchImpl = async (url) =>
      new Response(url.endsWith('.pdf') ? 'document' : 'image', {
        headers: { 'content-type': url.endsWith('.pdf') ? 'application/pdf' : 'image/jpeg' },
      });

    await archiveListings({ listings: [listing], provider: 'provider', jobId: 'job-1', fetchImpl });

    const capture = db.prepare(`SELECT raw_response FROM listing_archive WHERE listing_id = 'listing-1'`).get();
    expect(JSON.parse(capture.raw_response)).toEqual(listing.rawResponse);
    const media = db
      .prepare(
        `SELECT kind, media_root AS mediaRoot, relative_path AS relativePath, status
         FROM listing_archive_media ORDER BY kind`,
      )
      .all();
    expect(media).toHaveLength(2);
    expect(media.every((row) => row.status === 'stored')).toBe(true);
    expect(await readFile(path.join(media[0].mediaRoot, media[0].relativePath), 'utf8')).toBe('document');

    db.prepare(`DELETE FROM listings WHERE id = 'listing-1'`).run();
    expect(db.prepare(`SELECT COUNT(*) AS total FROM listing_archive_cleanup`).get().total).toBe(2);
    expect(await drainListingArchiveCleanup()).toBe(2);
    expect(db.prepare(`SELECT COUNT(*) AS total FROM listing_archive_cleanup`).get().total).toBe(0);
  });

  it('lists completed media and deletes only the selected file and metadata, preserving raw captures', async () => {
    db.prepare(`INSERT INTO listings (id) VALUES ('listing-1')`).run();
    await archiveListings({
      listings: [
        {
          id: 'listing-1',
          link: 'https://portal.example/listing-1',
          images: ['https://cdn.example/photo.jpg'],
          attachments: ['https://cdn.example/expose.pdf', 'https://cdn.example/missing.pdf'],
          rawResponse: { detail: { body: { documents: ['expose.pdf'] } } },
        },
      ],
      provider: 'provider',
      jobId: 'job-1',
      fetchImpl: async (url) =>
        new Response('bytes', {
          status: url.endsWith('missing.pdf') ? 404 : 200,
          headers: { 'content-type': url.endsWith('.pdf') ? 'application/pdf' : 'image/jpeg' },
        }),
    });
    const original = db.prepare('SELECT * FROM listing_archive').all();
    const media = listArchivedMedia('listing-1');
    expect(media.map((item) => item.filename)).toEqual(['photo.jpg', 'expose.pdf']);
    expect(media[0]).not.toHaveProperty('mediaRoot');
    expect(media[0]).not.toHaveProperty('relativePath');
    expect(media[0]).not.toHaveProperty('sourceUrl');
    const document = media[1];
    const file = archivedMediaLocalPath(getArchivedMedia(document.id, 'listing-1'));
    expect(getArchivedMedia(document.id, 'another-listing')).toBeNull();
    expect(await deleteArchivedMedia(document.id, 'another-listing')).toBe(false);
    expect(await readFile(file, 'utf8')).toBe('bytes');
    expect(await deleteArchivedMedia(document.id, 'listing-1')).toBe(true);
    await expect(readFile(file)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(getArchivedMedia(document.id, 'listing-1')).toBeNull();
    expect(listArchivedMedia('listing-1')).toEqual([media[0]]);
    expect(db.prepare('SELECT * FROM listing_archive').all()).toEqual(original);
    expect(db.prepare('SELECT * FROM listing_archive_cleanup').all()).toEqual([]);
    expect(await deleteArchivedMedia(document.id, 'listing-1')).toBe(false);
  });

  it('rejects paths outside the archived media root', () => {
    expect(() => archivedMediaLocalPath({ mediaRoot: mediaBase, relativePath: '../outside.pdf' })).toThrow(/escapes/);
  });

  it('retains a durable cleanup entry when immediate file removal fails', async () => {
    db.prepare(`INSERT INTO listings (id) VALUES ('listing-1')`).run();
    await archiveListings({
      listings: [{ id: 'listing-1', link: 'https://portal.example/1', attachments: ['https://cdn.example/file.pdf'] }],
      provider: 'provider',
      jobId: 'job-1',
      fetchImpl: async () => new Response('bytes', { headers: { 'content-type': 'application/pdf' } }),
    });
    const document = listArchivedMedia('listing-1')[0];
    const file = archivedMediaLocalPath(getArchivedMedia(document.id, 'listing-1'));
    const unlink = vi.spyOn(fs, 'unlink').mockRejectedValueOnce(Object.assign(new Error('busy'), { code: 'EBUSY' }));
    try {
      expect(await deleteArchivedMedia(document.id, 'listing-1')).toBe(true);
    } finally {
      unlink.mockRestore();
    }
    expect(listArchivedMedia('listing-1')).toEqual([]);
    expect(db.prepare('SELECT * FROM listing_archive_cleanup').all()).toHaveLength(1);
    expect(await readFile(file, 'utf8')).toBe('bytes');
    expect(await drainListingArchiveCleanup()).toBe(1);
    await expect(readFile(file)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('records unsafe downloads as failures instead of requesting them', async () => {
    const fetchImpl = vi.fn();
    const result = await archiveMediaItem({
      sourceUrl: 'http://127.0.0.1/private.jpg',
      baseUrl: 'https://portal.example/listing-1',
      kind: 'image',
      mediaRoot: mediaBase,
      provider: 'provider',
      jobKey: 'job-1',
      listingId: 'listing-1',
      fetchImpl,
    });

    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/publicly fetchable/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
