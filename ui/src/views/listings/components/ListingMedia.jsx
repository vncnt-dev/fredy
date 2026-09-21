/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { useEffect, useMemo, useState } from 'react';
import { Button, Image, ImagePreview, Popconfirm, Toast, Typography } from '@douyinfe/semi-ui-19';
import { IconDelete, IconFile, IconMaximize } from '@douyinfe/semi-icons';

import no_image from '../../../assets/no_image.png';
import { deleteProviderMedia, listProviderMedia, providerMediaUrl } from '../../../services/providerMediaClient.js';
import { useTranslation } from '../../../services/i18n/i18n.jsx';

import './ListingMedia.less';

const { Text } = Typography;
const DOCUMENT_TYPES = {
  'application/pdf': 'PDF',
  'application/msword': 'DOC',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'DOCX',
  'application/vnd.oasis.opendocument.text': 'ODT',
};

/** @param {number|null} bytes @returns {string} Human-readable file size. */
function humanSize(bytes) {
  if (!Number.isFinite(bytes)) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * The portal-owned half of a listing: archived gallery images and downloadable documents.
 *
 * Archived images replace the live portal URL when present, so an offline advert keeps its gallery.
 * Provider documents are kept separate from user uploads because they have a different origin and
 * lifecycle. They can be deleted here; gallery images deliberately cannot.
 *
 * @param {Object} props
 * @param {string} props.listingId
 * @param {Object} props.listing
 * @returns {React.ReactElement}
 */
export default function ListingMedia({ listingId, listing }) {
  const t = useTranslation();
  const [media, setMedia] = useState([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [previewVisible, setPreviewVisible] = useState(false);
  const [deletingId, setDeletingId] = useState(null);

  useEffect(() => {
    let cancelled = false;
    async function reload() {
      try {
        const payload = await listProviderMedia(listingId);
        if (!cancelled) setMedia(Array.isArray(payload.media) ? payload.media : []);
      } catch {
        if (!cancelled) Toast.error(t('listing.detail.providerMediaLoadError'));
      }
    }
    reload();
    return () => {
      cancelled = true;
    };
  }, [listingId, t]);

  const images = useMemo(() => media.filter((item) => item.kind === 'image'), [media]);
  const documents = useMemo(() => media.filter((item) => item.kind === 'attachment'), [media]);
  const imageUrls = useMemo(
    () =>
      images.length > 0
        ? images.map((item) => providerMediaUrl(listingId, item.id))
        : listing.image_url
          ? [listing.image_url]
          : [],
    [images, listing.image_url, listingId],
  );

  useEffect(() => {
    if (selectedIndex >= imageUrls.length) setSelectedIndex(Math.max(0, imageUrls.length - 1));
  }, [imageUrls.length, selectedIndex]);

  const currentUrl = imageUrls[selectedIndex] ?? null;
  const currentImage = images[selectedIndex];

  const handleDelete = async (mediaId) => {
    setDeletingId(mediaId);
    try {
      await deleteProviderMedia(listingId, mediaId);
      setMedia((items) => items.filter((item) => item.id !== mediaId));
      Toast.success(t('listing.detail.providerDocumentDeleted'));
    } catch {
      Toast.error(t('listing.detail.providerDocumentDeleteError'));
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div className="listing-media">
      <div className={`listing-detail__image${currentUrl ? '' : ' listing-detail__image--placeholder'}`}>
        <Image
          src={currentUrl ?? no_image}
          fallback={<img src={no_image} alt={t('listing.detail.noImageAlt')} />}
          alt={currentImage?.filename || listing.title || t('listing.detail.defaultTitle')}
          style={{ width: '100%', height: '100%' }}
          preview={false}
        />
        {currentUrl && (
          <button
            type="button"
            className="listing-detail__image-expand"
            aria-label={t('listing.detail.expandImage')}
            onClick={() => setPreviewVisible(true)}
          >
            <IconMaximize aria-hidden="true" />
          </button>
        )}
        {imageUrls.length > 1 && (
          <span className="listing-media__counter">
            {t('listing.detail.providerGalleryCounter', {
              current: selectedIndex + 1,
              total: imageUrls.length,
            })}
          </span>
        )}
      </div>

      {!currentUrl && (
        <Text type="tertiary" size="small" className="listing-detail__image-note">
          {t('listing.detail.noImageAlt')}
        </Text>
      )}

      {imageUrls.length > 1 && (
        <div className="listing-media__thumbnails">
          {imageUrls.map((url, index) => (
            <button
              key={images[index]?.id ?? url}
              type="button"
              className={`listing-media__thumbnail${selectedIndex === index ? ' listing-media__thumbnail--active' : ''}`}
              aria-label={t('listing.detail.providerGalleryThumbnail', { number: index + 1 })}
              aria-current={selectedIndex === index ? 'true' : undefined}
              onClick={() => setSelectedIndex(index)}
            >
              <img src={url} alt="" loading="lazy" />
            </button>
          ))}
        </div>
      )}

      {imageUrls.length > 0 && (
        <ImagePreview
          src={imageUrls}
          visible={previewVisible}
          currentIndex={selectedIndex}
          onChange={setSelectedIndex}
          onVisibleChange={setPreviewVisible}
          infinite
        />
      )}

      {documents.length > 0 && (
        <section className="listing-card listing-media__documents">
          <h2 className="listing-card__label">{t('listing.detail.providerDocumentsTitle')}</h2>
          <Text type="tertiary" size="small" className="listing-media__documents-hint">
            {t('listing.detail.providerDocumentsHint')}
          </Text>
          <ul className="listing-media__document-list">
            {documents.map((document) => (
              <li key={document.id} className="listing-media__document">
                <a
                  href={providerMediaUrl(listingId, document.id)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="listing-media__document-link"
                >
                  <span className="listing-media__document-icon">
                    <IconFile />
                  </span>
                  <span className="listing-media__document-meta">
                    <span className="listing-media__document-name">{document.filename}</span>
                    {document.sizeBytes != null && (
                      <Text type="tertiary" size="small">
                        {[DOCUMENT_TYPES[document.contentType], humanSize(document.sizeBytes)]
                          .filter(Boolean)
                          .join(' · ')}
                      </Text>
                    )}
                  </span>
                </a>
                <Popconfirm
                  title={t('listing.detail.providerDocumentDeleteTitle')}
                  content={t('listing.detail.providerDocumentDeleteConfirm')}
                  onConfirm={() => handleDelete(document.id)}
                >
                  <Button
                    icon={<IconDelete />}
                    theme="borderless"
                    type="danger"
                    loading={deletingId === document.id}
                    disabled={deletingId != null}
                    aria-label={t('listing.detail.providerDocumentDeleteTitle')}
                  />
                </Popconfirm>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
