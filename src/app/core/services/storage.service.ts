/**
 * Item photo uploads, backed by Supabase Storage.
 *
 * Security is layered:
 *   1. the browser checks type and size so the user gets instant feedback
 *   2. the bucket itself enforces a 5 MB cap and a MIME whitelist
 *      (see supabase/migrations/..._storage.sql)
 *   3. the storage policies only allow writes inside `<user-id>/…`,
 *      so one student can never touch another student's photo
 *
 * The file name is randomised, which prevents name collisions and stops
 * personal information leaking through the URL.
 */
import { Injectable, inject } from '@angular/core';
import { SupabaseService } from './supabase.service';

export const ITEM_IMAGE_BUCKET = 'item-images';
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5 MB — matches the bucket policy
export const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'] as const;

export interface UploadedImage {
  /** public URL stored in items.image_url */
  url: string;
  /** object path stored in items.image_path (used for cleanup) */
  path: string;
}

@Injectable({ providedIn: 'root' })
export class StorageService {
  private readonly supabase = inject(SupabaseService);

  /** Client-side validation, mirroring the bucket rules. */
  validate(file: File): { ok: true } | { ok: false; message: string } {
    if (!ALLOWED_IMAGE_TYPES.includes(file.type as (typeof ALLOWED_IMAGE_TYPES)[number])) {
      return { ok: false, message: 'Please choose a JPG, PNG or WEBP image.' };
    }
    if (file.size > MAX_IMAGE_BYTES) {
      return { ok: false, message: 'The image must be smaller than 5 MB.' };
    }
    return { ok: true };
  }

  /**
   * Upload a photo and return its public URL plus the storage path.
   * Throws a readable error when validation or the upload fails.
   */
  async uploadItemImage(file: File, userId: string): Promise<UploadedImage> {
    const check = this.validate(file);
    if (!check.ok) {
      throw new Error(check.message);
    }

    const extension = this.extensionFor(file);
    const path = `${userId}/${this.randomName()}.${extension}`;

    const { error } = await this.supabase.client.storage
      .from(ITEM_IMAGE_BUCKET)
      .upload(path, file, {
        cacheControl: '3600',
        upsert: false,
        contentType: file.type,
      });

    if (error) {
      throw new Error(SupabaseService.message(error));
    }

    const { data } = this.supabase.client.storage.from(ITEM_IMAGE_BUCKET).getPublicUrl(path);
    return { url: data.publicUrl, path };
  }

  /** Best-effort cleanup; never blocks the user's action if it fails. */
  async removeItemImage(path: string | null | undefined): Promise<void> {
    if (!path) {
      return;
    }
    try {
      await this.supabase.client.storage.from(ITEM_IMAGE_BUCKET).remove([path]);
    } catch {
      // an orphaned file is not worth interrupting the user for
    }
  }

  /** crypto-random, URL-safe name — no user data in the path. */
  private randomName(): string {
    const bytes = new Uint8Array(12);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  }

  private extensionFor(file: File): string {
    const fromName = file.name.split('.').pop()?.toLowerCase();
    if (fromName && ['jpg', 'jpeg', 'png', 'webp'].includes(fromName)) {
      return fromName === 'jpeg' ? 'jpg' : fromName;
    }
    const fromType: Record<string, string> = {
      'image/jpeg': 'jpg',
      'image/jpg': 'jpg',
      'image/png': 'png',
      'image/webp': 'webp',
    };
    return fromType[file.type] ?? 'jpg';
  }
}
