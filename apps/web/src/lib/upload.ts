import { type AssetKind, type PresignUploadBody } from '@platform/shared';

import { api } from './api';

interface PresignResponse {
  assetId: string;
  storageKey: string;
  uploadUrl: string;
  publicUrl: string | null;
  expiresInSeconds: number;
}

/**
 * Two-step upload:
 *   1. Ask the API for a presigned PUT URL (records the asset row server-side).
 *   2. PUT the bytes directly to object storage from the browser.
 *   3. Notify the API the upload is complete (records dimensions, checksum).
 */
export async function uploadFile(
  file: File,
  kind: AssetKind = 'image',
): Promise<{ assetId: string; url: string; storageKey: string }> {
  const presign = await api.post<PresignResponse>('/api/v1/assets/presign-upload', {
    kind,
    contentType: file.type,
    byteSize: file.size,
    filename: file.name,
  } satisfies PresignUploadBody);

  const putRes = await fetch(presign.uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': file.type },
    body: file,
  });
  if (!putRes.ok) throw new Error(`Upload failed (${putRes.status})`);

  // Try to read image dimensions in the browser before finalising.
  let width: number | undefined;
  let height: number | undefined;
  if (kind === 'image' && file.type.startsWith('image/')) {
    try {
      const dims = await readImageDimensions(file);
      width = dims.width;
      height = dims.height;
    } catch {
      // ignore
    }
  }

  await api.post(`/api/v1/assets/${presign.assetId}/finalize`, { width, height });

  let url = presign.publicUrl;
  if (!url) {
    const asset = await api.get<{ data: { url: string } }>(`/api/v1/assets/${presign.assetId}/url`);
    url = asset.data.url;
  }
  return { assetId: presign.assetId, url, storageKey: presign.storageKey };
}

function readImageDimensions(file: File): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve({ width: img.naturalWidth, height: img.naturalHeight });
    };
    img.onerror = (err) => {
      URL.revokeObjectURL(url);
      reject(err);
    };
    img.src = url;
  });
}
