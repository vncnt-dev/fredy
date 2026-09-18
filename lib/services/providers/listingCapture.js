/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import * as cheerio from 'cheerio';

/**
 * @typedef {'json'|'html'} ResponseFormat
 * @typedef {{format: ResponseFormat, contentType: string, body: any}} CapturedResponse
 */

/**
 * Wrap a provider response in the stable shape consumed by persistence adapters.
 *
 * @param {ResponseFormat} format
 * @param {any} body
 * @returns {CapturedResponse}
 */
export function capturedResponse(format, body) {
  return {
    format,
    contentType: format === 'json' ? 'application/json' : 'text/html',
    body,
  };
}

/**
 * @param {ResponseFormat} format
 * @param {any} body
 * @returns {{search: CapturedResponse, detail: null, detailStatus: 'unsupported'}}
 */
export function searchCapture(format, body) {
  return {
    search: capturedResponse(format, body),
    detail: null,
    detailStatus: 'unsupported',
  };
}

/**
 * Preserve capture fields when a provider's normalize function returns a new object.
 *
 * Providers using the generic HTML parser already carry a capture. For custom JSON providers the
 * fallback is the exact object returned by getListings; providers that transform a larger API
 * object should attach their own searchCapture before returning it.
 *
 * @param {any} raw
 * @param {any} normalized
 * @returns {any}
 */
export function preserveCapture(raw, normalized) {
  const rawResponse =
    normalized.rawResponse ??
    raw?.rawResponse ??
    searchCapture(
      'json',
      raw == null || typeof raw !== 'object'
        ? raw
        : Object.fromEntries(
            Object.entries(raw).filter(([key]) => !['rawResponse', 'images', 'attachments'].includes(key)),
          ),
    );

  const responseImages = rawResponse?.search?.format === 'json' ? imagesFromJson(rawResponse.search.body) : [];
  const responseAttachments =
    rawResponse?.search?.format === 'json' ? attachmentsFromJson(rawResponse.search.body) : [];

  normalized.rawResponse = rawResponse;
  normalized.images = uniqueUrls([
    ...(raw?.images ?? []),
    ...(normalized.images ?? []),
    normalized.image,
    ...responseImages,
  ]);
  normalized.attachments = uniqueUrls([
    ...(raw?.attachments ?? []),
    ...(normalized.attachments ?? []),
    ...responseAttachments,
  ]);
  return normalized;
}

/**
 * Add a complete detail response and media discovered in it.
 *
 * @param {any} listing
 * @param {ResponseFormat} format
 * @param {any} body
 * @param {{images?: Array<string|null|undefined>, attachments?: Array<string|null|undefined>}} [media]
 * @returns {any}
 */
export function withDetailCapture(listing, format, body, media = {}) {
  listing.rawResponse = {
    ...(listing.rawResponse ?? {}),
    detail: capturedResponse(format, body),
    detailStatus: 'captured',
  };
  listing.images = uniqueUrls([...(listing.images ?? []), listing.image, ...(media.images ?? [])]);
  listing.attachments = uniqueUrls([...(listing.attachments ?? []), ...(media.attachments ?? [])]);
  return listing;
}

/**
 * Mark a detail request as failed without discarding the search response.
 *
 * @param {any} listing
 * @returns {any}
 */
export function withFailedDetailCapture(listing) {
  listing.rawResponse = {
    ...(listing.rawResponse ?? {}),
    detail: null,
    detailStatus: 'failed',
  };
  return listing;
}

/**
 * @param {any} listing
 * @param {'disabled'|'unsupported'} status
 * @returns {any}
 */
export function withDetailStatus(listing, status) {
  listing.rawResponse = {
    ...(listing.rawResponse ?? {}),
    detail: null,
    detailStatus: status,
  };
  return listing;
}

/**
 * @param {Array<string|null|undefined>} urls
 * @returns {string[]}
 */
export function uniqueUrls(urls) {
  return [...new Set(urls.filter((url) => typeof url === 'string' && url.trim().length > 0).map((url) => url.trim()))];
}

/**
 * Extract listing media candidates from a detail page.
 *
 * Default selectors cover semantic image metadata and common gallery/carousel containers without
 * archiving every logo and icon on the page. Callers may provide portal-specific selectors.
 * Document links use their file extension because arbitrary anchors on a detail page include
 * navigation, ads and account links.
 *
 * @param {string} html
 * @param {string[]} [imageSelectors]
 * @returns {{images: string[], attachments: string[]}}
 */
export function mediaFromHtml(
  html,
  imageSelectors = [
    'meta[property="og:image"]',
    '[itemprop="image"]',
    '[class*="gallery" i] img',
    '[id*="gallery" i] img',
    '[class*="carousel" i] img',
    '[id*="carousel" i] img',
    '[class*="slider" i] img',
    '[id*="slider" i] img',
  ],
) {
  const $ = cheerio.load(html);
  const images = [];
  for (const selector of imageSelectors) {
    $(selector).each((_, element) => {
      const node = $(element);
      const ownSrcset = node.attr('data-srcset') ?? node.attr('srcset');
      const pictureSrcset =
        node.closest('picture').find('source[data-srcset], source[srcset]').last().attr('data-srcset') ??
        node.closest('picture').find('source[srcset]').last().attr('srcset');
      images.push(
        node.attr('content') ??
          node.attr('data-imgsrc') ??
          node.attr('data-src') ??
          node.attr('data-lazy-src') ??
          largestSrcsetUrl(ownSrcset ?? pictureSrcset) ??
          node.attr('src'),
      );
    });
  }

  const attachments = [];
  $('a[href]').each((_, element) => {
    const href = $(element).attr('href');
    if (/\.(?:pdf|docx?|odt)(?:[?#].*)?$/i.test(href ?? '')) attachments.push(href);
  });

  return { images: uniqueUrls(images), attachments: uniqueUrls(attachments) };
}

function largestSrcsetUrl(srcset) {
  if (typeof srcset !== 'string') return null;
  const candidates = srcset
    .split(',')
    .map((candidate) => candidate.trim().split(/\s+/, 1)[0])
    .filter(Boolean);
  return candidates.at(-1) ?? null;
}

/**
 * Find document URLs in a JSON response without treating arbitrary links as attachments.
 *
 * @param {any} value
 * @returns {string[]}
 */
export function attachmentsFromJson(value) {
  const urls = [];
  const visit = (current) => {
    if (typeof current === 'string') {
      if (/^https?:\/\/.*\.(?:pdf|docx?|odt)(?:[?#].*)?$/i.test(current)) urls.push(current);
      return;
    }
    if (Array.isArray(current)) {
      current.forEach(visit);
      return;
    }
    if (current != null && typeof current === 'object') Object.values(current).forEach(visit);
  };
  visit(value);
  return uniqueUrls(urls);
}

/**
 * Find image URLs in one listing-specific JSON object.
 *
 * The ancestry check intentionally requires an image/media-shaped key. Listing payloads contain
 * unrelated links (agent pages, reports, badges); accepting every URL ending in an image extension
 * would archive those alongside the property gallery.
 *
 * @param {any} value
 * @returns {string[]}
 */
export function imagesFromJson(value) {
  const urls = [];
  const visit = (current, ancestry = []) => {
    if (typeof current === 'string') {
      const imageContext = ancestry.some((key) => /image|picture|photo|media|gallery|cover/i.test(key));
      if (imageContext && /^https?:\/\//i.test(current)) urls.push(current);
      return;
    }
    if (Array.isArray(current)) {
      current.forEach((entry) => visit(entry, ancestry));
      return;
    }
    if (current != null && typeof current === 'object') {
      for (const [key, child] of Object.entries(current)) visit(child, [...ancestry, key]);
    }
  };
  visit(value);
  return uniqueUrls(urls);
}
