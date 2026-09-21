/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { nanoid } from 'nanoid';

export const DEFAULT_LISTING_MEDIA_ROOT = 'listing-media';

/**
 * Store provider captures in Fredy's database while keeping downloaded bytes on disk.
 *
 * The capture is deliberately not a column on `listings`: several listing queries select `l.*`,
 * and putting a complete provider response there would make every overview and API response carry
 * potentially megabytes of JSON or HTML. The one-to-one table keeps that payload internal.
 *
 * Media rows cascade with their listing. Their files cannot be removed by a foreign key, so the
 * trigger copies every stored path into a durable queue before the metadata disappears. A cleanup
 * worker can then unlink it after the database transaction commits and retry after a crash.
 *
 * This migration also retires the custom PostgreSQL notification channel. Its external database is
 * intentionally untouched; only Fredy's channel rows and job references are removed.
 *
 * @param {import('better-sqlite3').Database} db
 * @returns {void}
 */
export function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS listing_archive (
      listing_id TEXT PRIMARY KEY REFERENCES listings(id) ON DELETE CASCADE,
      raw_response TEXT NOT NULL,
      archived_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS listing_archive_media (
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

    CREATE INDEX IF NOT EXISTS idx_listing_archive_media_listing
      ON listing_archive_media (listing_id);

    CREATE TABLE IF NOT EXISTS listing_archive_cleanup (
      media_root TEXT NOT NULL,
      relative_path TEXT NOT NULL,
      queued_at INTEGER NOT NULL,
      PRIMARY KEY (media_root, relative_path)
    );

    CREATE TRIGGER IF NOT EXISTS queue_listing_archive_media_cleanup
    AFTER DELETE ON listing_archive_media
    WHEN OLD.relative_path IS NOT NULL
    BEGIN
      INSERT OR IGNORE INTO listing_archive_cleanup (media_root, relative_path, queued_at)
      VALUES (OLD.media_root, OLD.relative_path, unixepoch('subsec') * 1000);
    END;
  `);

  seedSetting(db, 'listingMediaRoot', DEFAULT_LISTING_MEDIA_ROOT);
  removePostgresCustomChannels(db);
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} name
 * @param {any} value
 */
function seedSetting(db, name, value) {
  const exists = db.prepare(`SELECT 1 FROM settings WHERE name = @name AND user_id IS NULL LIMIT 1`).get({ name });
  if (exists) return;
  db.prepare(
    `INSERT INTO settings (id, create_date, name, value, user_id)
     VALUES (@id, @create_date, @name, @value, NULL)`,
  ).run({ id: nanoid(), create_date: Date.now(), name, value: JSON.stringify(value) });
}

/**
 * Remove obsolete postgres_custom channel references without disturbing other channels.
 *
 * @param {import('better-sqlite3').Database} db
 */
function removePostgresCustomChannels(db) {
  const obsoleteIds = new Set(
    db
      .prepare(`SELECT id FROM configured_adapter WHERE adapter_id = 'postgres_custom'`)
      .all()
      .map((row) => row.id),
  );
  if (obsoleteIds.size === 0) return;

  const updateJob = db.prepare(`UPDATE jobs SET notification_adapter = @notificationAdapter WHERE id = @id`);
  for (const job of db.prepare(`SELECT id, notification_adapter FROM jobs`).all()) {
    let references;
    try {
      references = JSON.parse(job.notification_adapter ?? '[]');
    } catch {
      continue;
    }
    if (!Array.isArray(references)) continue;
    const kept = references.filter((entry) => !obsoleteIds.has(entry?.configuredAdapterId));
    if (kept.length !== references.length) {
      updateJob.run({ id: job.id, notificationAdapter: JSON.stringify(kept) });
    }
  }

  db.prepare(`DELETE FROM configured_adapter WHERE adapter_id = 'postgres_custom'`).run();
}
