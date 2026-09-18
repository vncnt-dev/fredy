/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { mkdtemp, rm } from 'fs/promises';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { sendListings } from '../../lib/notification/adapter/postgres_custom.js';

describe('postgres_custom adapter', () => {
  it('creates the table and inserts raw payload plus archived media as jsonb', async () => {
    const mediaRoot = await mkdtemp(path.join(os.tmpdir(), 'fredy-postgres-custom-'));
    const clients = [];
    class FakeClient {
      constructor(options) {
        this.options = options;
        this.queries = [];
        clients.push(this);
      }
      async connect() {}
      async query(sql, values) {
        this.queries.push({ sql, values });
      }
      async end() {
        this.ended = true;
      }
    }

    try {
      await sendListings(
        {
          serviceName: 'immoscout',
          jobKey: 'job-1',
          notificationConfig: [
            {
              id: 'postgres_custom',
              fields: {
                connectionString: 'postgresql://fredy:secret@db/fredy',
                mediaRoot,
              },
            },
          ],
          newListings: [
            {
              id: 'listing-1',
              title: 'Flat',
              link: 'https://portal.example/listing-1',
              image: 'https://cdn.example/one.jpg',
              images: ['https://cdn.example/one.jpg', 'https://cdn.example/two.jpg'],
              attachments: [],
              rawResponse: searchCaptureFixture(),
            },
          ],
        },
        {
          ClientClass: FakeClient,
          fetchImpl: async () => new Response('image', { headers: { 'content-type': 'image/jpeg' } }),
        },
      );

      expect(clients).toHaveLength(1);
      expect(clients[0].options.connectionString).toContain('secret');
      expect(clients[0].ended).toBe(true);
      expect(clients[0].queries[0].sql).toContain('raw_response JSONB');
      const insert = clients[0].queries.find((query) => query.values);
      expect(JSON.parse(insert.values[11])).toEqual(searchCaptureFixture());
      expect(JSON.parse(insert.values[12])).toHaveLength(2);
      expect(JSON.parse(insert.values[13])).toEqual([]);
    } finally {
      await rm(mediaRoot, { recursive: true, force: true });
    }
  });
});

function searchCaptureFixture() {
  return {
    search: { format: 'json', contentType: 'application/json', body: { sourceId: 1 } },
    detail: null,
    detailStatus: 'disabled',
  };
}
