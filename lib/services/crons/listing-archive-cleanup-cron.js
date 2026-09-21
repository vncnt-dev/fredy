/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import cron from 'node-cron';
import { drainListingArchiveCleanup } from '../listings/listingArchive.js';
import logger from '../logger.js';

const LISTING_ARCHIVE_CLEANUP_CRON = '*/15 * * * *';

/**
 * Drain paths queued by cascading listing deletes without allowing a filesystem problem to take
 * down a scheduled task.
 *
 * @returns {Promise<number>}
 */
export async function runListingArchiveCleanup() {
  try {
    const cleaned = await drainListingArchiveCleanup();
    if (cleaned > 0) logger.debug(`Removed ${cleaned} archived listing media file(s).`);
    return cleaned;
  } catch (error) {
    logger.warn('Listing archive cleanup failed', error);
    return 0;
  }
}

/**
 * Clean leftovers once at startup, then retry queued files every fifteen minutes.
 *
 * @returns {Promise<void>}
 */
export async function initListingArchiveCleanupCron() {
  await runListingArchiveCleanup();
  cron.schedule(LISTING_ARCHIVE_CLEANUP_CRON, runListingArchiveCleanup);
}
