/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { Client } from 'pg';
import path from 'path';
import { readAdapterReadme } from '../../services/markdown.js';
import { computeDbPath } from '../../services/storage/SqliteConnection.js';
import { archiveListingMedia } from '../mediaArchive.js';
import { toPriceChangeListing } from '../priceChangeMessage.js';

const CREATE_LISTING_TABLE = `
  CREATE TABLE IF NOT EXISTS listing (
    record_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    service_name TEXT NOT NULL,
    job_key TEXT NOT NULL,
    id TEXT NOT NULL,
    size TEXT,
    rooms TEXT,
    price TEXT,
    address TEXT,
    title TEXT,
    link TEXT,
    description TEXT,
    image TEXT,
    raw_response JSONB NOT NULL,
    images JSONB NOT NULL DEFAULT '[]'::jsonb,
    attachments JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )
`;

const CREATE_PRICE_CHANGE_TABLE = `
  CREATE TABLE IF NOT EXISTS price_change (
    record_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    service_name TEXT NOT NULL,
    job_key TEXT NOT NULL,
    id TEXT,
    title TEXT,
    address TEXT,
    link TEXT,
    old_price TEXT,
    new_price TEXT,
    change_percent TEXT,
    direction TEXT,
    observed_at TIMESTAMPTZ NOT NULL
  )
`;

const INSERT_LISTING = `
  INSERT INTO listing (
    service_name, job_key, id, size, rooms, price, address, title, link, description, image,
    raw_response, images, attachments
  ) VALUES (
    $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13::jsonb, $14::jsonb
  )
`;

function findConfig(notificationConfig) {
  const adapter = notificationConfig.find((entry) => entry.id === config.id);
  const connectionString = adapter?.fields?.connectionString?.trim();
  if (!connectionString) throw new Error('postgres_custom requires a PostgreSQL connection string');
  return { connectionString, mediaRoot: adapter?.fields?.mediaRoot?.trim() };
}

async function resolveMediaRoot(configuredRoot) {
  if (configuredRoot) return path.resolve(configuredRoot);
  const { dir } = await computeDbPath();
  return path.join(dir, 'postgres_custom-media');
}

export async function sendListings(params, dependencies = {}) {
  const { serviceName, newListings, jobKey, notificationConfig } = params;
  const { connectionString, mediaRoot: configuredRoot } = findConfig(notificationConfig);
  const mediaRoot = await resolveMediaRoot(configuredRoot);
  const ClientClass = dependencies.ClientClass ?? Client;
  const client = new ClientClass({ connectionString });

  await client.connect();
  try {
    await client.query(CREATE_LISTING_TABLE);
    for (const listing of newListings) {
      const archived = await archiveListingMedia({
        images: listing.images ?? [listing.image].filter(Boolean),
        attachments: listing.attachments ?? [],
        baseUrl: listing.link,
        mediaRoot,
        provider: serviceName,
        jobKey,
        listingId: listing.id,
        fetchImpl: dependencies.fetchImpl,
      });
      await client.query(INSERT_LISTING, [
        serviceName,
        jobKey,
        listing.id,
        listing.size ?? null,
        listing.rooms ?? null,
        listing.price ?? null,
        listing.address ?? null,
        listing.title ?? null,
        listing.link ?? null,
        listing.description ?? null,
        listing.image ?? null,
        JSON.stringify(
          listing.rawResponse ?? {
            search: { format: 'json', contentType: 'application/json', body: listing },
            detail: null,
            detailStatus: 'unsupported',
          },
        ),
        JSON.stringify(archived.images),
        JSON.stringify(archived.attachments),
      ]);
    }
  } finally {
    await client.end();
  }
}

export const send = (params) => sendListings(params);

export async function sendPriceChanges(params, dependencies = {}) {
  const { serviceName, priceChanges, jobKey, notificationConfig } = params;
  const { connectionString } = findConfig(notificationConfig);
  const ClientClass = dependencies.ClientClass ?? Client;
  const client = new ClientClass({ connectionString });
  await client.connect();
  try {
    await client.query(CREATE_PRICE_CHANGE_TABLE);
    const observedAt = new Date();
    for (const change of priceChanges) {
      const listing = toPriceChangeListing(change);
      await client.query(
        `INSERT INTO price_change (
          service_name, job_key, id, title, address, link, old_price, new_price,
          change_percent, direction, observed_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          serviceName,
          jobKey,
          listing.id ?? null,
          change.title ?? null,
          change.address ?? null,
          change.link ?? null,
          change.oldPrice ?? null,
          change.newPrice ?? null,
          change.changePercent ?? null,
          change.direction ?? null,
          observedAt,
        ],
      );
    }
  } finally {
    await client.end();
  }
}

export const sendPriceChange = (params) => sendPriceChanges(params);

export const config = {
  id: 'postgres_custom',
  name: 'PostgreSQL Custom',
  description: 'Stores complete provider payloads and downloaded listing media in PostgreSQL.',
  fields: {
    connectionString: {
      type: 'text',
      label: 'PostgreSQL Connection String',
      description: 'Example: postgresql://fredy:password@postgres:5432/fredy',
      placeholder: 'postgresql://fredy:password@postgres:5432/fredy',
      secret: true,
      target: true,
    },
    mediaRoot: {
      type: 'text',
      label: 'Media Directory',
      description:
        "Directory for downloaded images and documents. Defaults to postgres_custom-media beside Fredy's database.",
      placeholder: '/db/postgres_custom-media',
    },
  },
  readme: readAdapterReadme('postgres_custom.md'),
};
