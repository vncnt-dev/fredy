/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { describe, expect, it } from 'vitest';
import {
  imagesFromJson,
  mediaFromHtml,
  preserveCapture,
  searchCapture,
  withDetailCapture,
} from '../../../lib/services/providers/listingCapture.js';

describe('listing capture', () => {
  it('preserves the exact JSON listing and every image-shaped URL', () => {
    const raw = {
      id: 'source-1',
      pictures: [{ fullImageUrl: 'https://img.example/one.jpg' }, { fullImageUrl: 'https://img.example/two.jpg' }],
      reportUrl: 'https://example.org/report',
    };
    const listing = preserveCapture(raw, {
      id: 'hash',
      link: 'https://example.org/1',
      title: 'A flat',
      image: 'https://img.example/one.jpg',
    });

    expect(listing.rawResponse.search.body).toEqual(raw);
    expect(listing.images).toEqual(['https://img.example/one.jpg', 'https://img.example/two.jpg']);
  });

  it('stores HTML as a JSON-compatible string and extracts selected gallery media', () => {
    const html =
      '<article><img class="gallery" src="https://img.example/a.jpg"><a href="/expose.pdf">PDF</a></article>';
    const media = mediaFromHtml(html, ['img.gallery']);
    const captured = withDetailCapture(
      { rawResponse: searchCapture('html', '<article>card</article>'), image: media.images[0] },
      'html',
      html,
      media,
    );

    expect(captured.rawResponse.detail.body).toBe(html);
    expect(captured.images).toEqual(['https://img.example/a.jpg']);
    expect(captured.attachments).toEqual(['/expose.pdf']);
    expect(() => JSON.stringify(captured.rawResponse)).not.toThrow();
  });

  it('does not treat unrelated JSON URLs as images', () => {
    expect(
      imagesFromJson({
        agentUrl: 'https://example.org/agent.jpg',
        gallery: [{ url: 'https://img.example/property.webp' }],
      }),
    ).toEqual(['https://img.example/property.webp']);
  });

  it('captures every gallery image and prefers the largest lazy-loaded source', () => {
    const media = mediaFromHtml(`
      <div class="property-gallery">
        <img src="https://img.example/one-small.jpg"
             srcset="https://img.example/one-small.jpg 400w, https://img.example/one-large.jpg 1200w">
        <picture>
          <source data-srcset="https://img.example/two-small.webp 400w, https://img.example/two-large.webp 1200w">
          <img data-src="https://img.example/two.jpg">
        </picture>
      </div>
      <img src="https://img.example/logo.svg">
    `);

    expect(media.images).toEqual(['https://img.example/one-large.jpg', 'https://img.example/two.jpg']);
  });
});
