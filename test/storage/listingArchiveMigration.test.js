/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import {
  DEFAULT_LISTING_MEDIA_ROOT,
  up,
} from '../../lib/services/storage/migrations/sql/45.internal-listing-archive.js';

describe('migration 45 - internal listing archive', () => {
  let db;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(`
      CREATE TABLE listings (id TEXT PRIMARY KEY);
      CREATE TABLE jobs (id TEXT PRIMARY KEY, notification_adapter TEXT NOT NULL DEFAULT '[]');
      CREATE TABLE configured_adapter (id TEXT PRIMARY KEY, adapter_id TEXT NOT NULL);
      CREATE TABLE settings (
        id TEXT PRIMARY KEY,
        create_date INTEGER,
        name TEXT,
        value TEXT,
        user_id TEXT
      );
    `);
  });

  afterEach(() => db.close());

  it('creates archive tables, indexes and the default media root idempotently', () => {
    up(db);
    expect(() => up(db)).not.toThrow();

    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
      .all()
      .map((row) => row.name);
    expect(tables).toEqual(
      expect.arrayContaining(['listing_archive', 'listing_archive_media', 'listing_archive_cleanup']),
    );
    expect(
      db.prepare(`SELECT value FROM settings WHERE name = 'listingMediaRoot' AND user_id IS NULL`).get().value,
    ).toBe(JSON.stringify(DEFAULT_LISTING_MEDIA_ROOT));
    expect(db.prepare(`SELECT COUNT(*) AS total FROM settings WHERE name = 'listingMediaRoot'`).get().total).toBe(1);
  });

  it('queues a stored file when its listing is deleted by cascade', () => {
    up(db);
    db.prepare(`INSERT INTO listings (id) VALUES ('listing-1')`).run();
    db.prepare(
      `INSERT INTO listing_archive_media (
         id, listing_id, kind, source_url, media_root, relative_path, status, created_at, updated_at
       ) VALUES ('media-1', 'listing-1', 'image', 'https://example.com/a.jpg', '/media',
                 'provider/job/listing/a.jpg', 'stored', 1, 1)`,
    ).run();

    db.prepare(`DELETE FROM listings WHERE id = 'listing-1'`).run();

    expect(db.prepare(`SELECT COUNT(*) AS total FROM listing_archive_media`).get().total).toBe(0);
    expect(db.prepare(`SELECT media_root, relative_path FROM listing_archive_cleanup`).get()).toEqual({
      media_root: '/media',
      relative_path: 'provider/job/listing/a.jpg',
    });
  });

  it('removes postgres_custom channels and only their job references', () => {
    db.exec(`
      INSERT INTO configured_adapter (id, adapter_id) VALUES
        ('postgres-channel', 'postgres_custom'),
        ('telegram-channel', 'telegram');
      INSERT INTO jobs (id, notification_adapter) VALUES (
        'job-1',
        '[{"configuredAdapterId":"postgres-channel"},{"configuredAdapterId":"telegram-channel"}]'
      );
    `);

    up(db);

    expect(db.prepare(`SELECT id FROM configured_adapter ORDER BY id`).all()).toEqual([{ id: 'telegram-channel' }]);
    expect(
      JSON.parse(db.prepare(`SELECT notification_adapter FROM jobs WHERE id = 'job-1'`).get().notification_adapter),
    ).toEqual([{ configuredAdapterId: 'telegram-channel' }]);
  });
});
