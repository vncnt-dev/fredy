/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * @typedef {Object} ArchivedProviderMedia
 * @property {string} id
 * @property {string} listingId
 * @property {'image'|'attachment'} kind
 * @property {string} filename
 * @property {string|null} contentType
 * @property {number|null} sizeBytes
 * @property {number} createdAt
 */

async function toError(response, fallback) {
  let message = fallback;
  try {
    const body = await response.json();
    message = body?.message || body?.error || fallback;
  } catch {
    // A non-JSON response has no useful detail beyond the fallback.
  }
  const error = new Error(message);
  error.status = response.status;
  return error;
}

/**
 * Provider-owned media Fredy archived for one listing.
 *
 * @param {string} listingId
 * @returns {Promise<{media: ArchivedProviderMedia[]}>}
 */
export async function listProviderMedia(listingId) {
  const response = await fetch(`/api/listings/${encodeURIComponent(listingId)}/media`, {
    credentials: 'include',
  });
  if (!response.ok) throw await toError(response, 'Failed to load archived provider media');
  return response.json();
}

/**
 * Same-origin URL for an archived provider file.
 *
 * @param {string} listingId
 * @param {string} mediaId
 * @returns {string}
 */
export function providerMediaUrl(listingId, mediaId) {
  return `/api/listings/${encodeURIComponent(listingId)}/media/${encodeURIComponent(mediaId)}`;
}

/**
 * Delete one provider attachment. The backend deliberately refuses gallery images.
 *
 * @param {string} listingId
 * @param {string} mediaId
 * @returns {Promise<void>}
 */
export async function deleteProviderMedia(listingId, mediaId) {
  const response = await fetch(providerMediaUrl(listingId, mediaId), {
    method: 'DELETE',
    credentials: 'include',
  });
  if (!response.ok) throw await toError(response, 'Delete failed');
}
