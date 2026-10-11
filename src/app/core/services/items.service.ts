/**
 * Lost/found reports, server-side search, and item lifecycle operations.
 * Search is executed by a dedicated indexed PostgreSQL function that selects
 * only public item fields. Private exact locations live in a separate RLS-
 * protected table and are never returned by search or public item details.
 */
import { Injectable, inject } from '@angular/core';
import { environment } from '../../../environments/environment';
import type {
  Item,
  ItemWithReporter,
  PublicItemSearchResult,
  PublicProfile,
  PublicStats,
} from '../models/database.types';
import type { ItemFilters, ItemFormValue, Paginated } from '../models/common.model';
import { SupabaseService } from './supabase.service';

/** Columns the item owner may edit; private exact-location data is excluded. */
export type ItemWritePayload = Partial<
  Pick<
    Item,
    | 'title'
    | 'category'
    | 'description'
    | 'location'
    | 'date_occurred'
    | 'keywords'
    | 'identifying_characteristics'
    | 'collection_instructions'
    | 'image_url'
    | 'image_path'
  >
>;

@Injectable({ providedIn: 'root' })
export class ItemsService {
  private readonly supabase = inject(SupabaseService);

  /* ------------------------------------------------------------------ */
  /* search                                                             */
  /* ------------------------------------------------------------------ */

  /**
   * Database-side full-text + partial, case-insensitive search, filters and
   * pagination. The RPC's query vector and trigram indexes cover title,
   * description, category, keywords, identifying characteristics and public
   * general location. It never reads item_private_details or claims.
   */
  async search(filters: ItemFilters = {}): Promise<Paginated<ItemWithReporter>> {
    const page = Math.max(1, filters.page ?? 1);
    const pageSize = Math.min(48, Math.max(1, filters.pageSize ?? environment.pageSize));
    const { data, error } = await this.supabase.client.rpc('search_public_items', {
      p_search: this.sanitiseTerm(filters.search),
      p_type: filters.type || null,
      p_category: filters.category || null,
      p_location: filters.location?.trim() || null,
      p_status: filters.status || null,
      p_date_from: filters.dateFrom || null,
      p_date_to: filters.dateTo || null,
      p_page: page,
      p_page_size: pageSize,
      p_hide_rejected: filters.hideRejected !== false,
      p_sort: filters.sort ?? 'newest',
    });

    if (error) {
      throw new Error(SupabaseService.message(error));
    }
    if (!data || typeof data !== 'object') {
      throw new Error('The item search returned an invalid response.');
    }

    const result = data as PublicItemSearchResult;
    const rows = Array.isArray(result.rows) ? result.rows : [];
    return {
      rows: await this.attachReporters(rows),
      total: Number.isFinite(result.total) ? result.total : 0,
      page: Number.isFinite(result.page) ? result.page : page,
      pageSize: Number.isFinite(result.pageSize) ? result.pageSize : pageSize,
      totalPages: Number.isFinite(result.totalPages) ? result.totalPages : 1,
    };
  }

  /** Sanitize text before passing it to PostgREST/PostgreSQL search. */
  private sanitiseTerm(input?: string): string | null {
    const cleaned = (input ?? '')
      .replace(/[^\p{L}\p{N}\s'-]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 100);
    return cleaned.length >= 2 ? cleaned : null;
  }

  /* ------------------------------------------------------------------ */
  /* single item and private finder access                              */
  /* ------------------------------------------------------------------ */

  async getById(id: string): Promise<ItemWithReporter | null> {
    const { data, error } = await this.supabase.client
      .from('items')
      .select('*')
      .eq('id', id)
      .maybeSingle<Item>();

    if (error) {
      throw new Error(SupabaseService.message(error));
    }
    if (!data) {
      return null;
    }
    const [hydrated] = await this.attachReporters([data]);
    return hydrated;
  }

  /**
   * Read a private exact find location. Call only for the reporting finder;
   * the database RLS independently allows only the finder or an admin.
   */
  async getPrivateFoundLocation(itemId: string): Promise<string | null> {
    const { data, error } = await this.supabase.client
      .from('item_private_details')
      .select('exact_found_location')
      .eq('item_id', itemId)
      .maybeSingle<{ exact_found_location: string }>();
    if (error) {
      throw new Error(SupabaseService.message(error));
    }
    return data?.exact_found_location ?? null;
  }

  /* ------------------------------------------------------------------ */
  /* create / update / delete                                           */
  /* ------------------------------------------------------------------ */

  /**
   * Atomically create a public report and, for found items, its private exact
   * discovery location. The database derives reported_by from auth.uid(); the
   * userId argument is intentionally not client-supplied.
   */
  async create(value: ItemFormValue, image?: { url: string; path: string } | null): Promise<Item> {
    const { data, error } = await this.supabase.client.rpc('create_item_report', {
      p_type: value.type,
      p_title: value.title.trim(),
      p_category: value.category,
      p_description: value.description.trim(),
      p_location: value.location.trim(),
      p_date_occurred: value.date_occurred,
      p_keywords: value.keywords.trim(),
      p_identifying_characteristics: value.identifying_characteristics.trim(),
      p_collection_instructions:
        value.type === 'found' ? value.collection_instructions?.trim() || null : null,
      p_exact_found_location:
        value.type === 'found' ? value.exact_found_location?.trim() || null : null,
      p_image_url: image?.url ?? null,
      p_image_path: image?.path ?? null,
    });

    if (error) {
      throw new Error(SupabaseService.message(error));
    }
    if (!data || typeof data !== 'object') {
      throw new Error('The report was not returned by the database.');
    }
    return data as Item;
  }

  /** Update public fields of a report the current user owns. */
  async update(id: string, patch: ItemWritePayload): Promise<Item> {
    const { data, error } = await this.supabase.client
      .from('items')
      .update(patch)
      .eq('id', id)
      .select('*')
      .single<Item>();

    if (error) {
      throw new Error(SupabaseService.message(error));
    }
    return data;
  }

  /** Owner closes their own report. */
  async close(id: string): Promise<void> {
    const { error } = await this.supabase.client
      .from('items')
      .update({ status: 'closed', resolved_at: new Date().toISOString() })
      .eq('id', id);
    if (error) {
      throw new Error(SupabaseService.message(error));
    }
  }

  /** Owner re-opens a report they closed by mistake. */
  async reopen(id: string): Promise<void> {
    const { error } = await this.supabase.client
      .from('items')
      .update({ status: 'active', resolved_at: null })
      .eq('id', id);
    if (error) {
      throw new Error(SupabaseService.message(error));
    }
  }

  async remove(id: string): Promise<void> {
    const { error } = await this.supabase.client.from('items').delete().eq('id', id);
    if (error) {
      throw new Error(SupabaseService.message(error));
    }
  }

  /** Finder-confirmed physical handover; approval and handover are separate. */
  async confirmHandover(itemId: string): Promise<void> {
    const { error } = await this.supabase.client.rpc('confirm_item_handover', {
      p_item_id: itemId,
    });
    if (error) {
      throw new Error(SupabaseService.message(error));
    }
  }

  /* ------------------------------------------------------------------ */
  /* dashboard counters                                                */
  /* ------------------------------------------------------------------ */

  async publicStats(): Promise<PublicStats> {
    const { data, error } = await this.supabase.client.rpc('public_stats');
    if (error) {
      throw new Error(SupabaseService.message(error));
    }
    return data as PublicStats;
  }

  /** Counts for the signed-in campus member's own dashboard. */
  async myStats(userId: string): Promise<{
    lost: number;
    found: number;
    active: number;
    returned: number;
    closed: number;
  }> {
    const { data, error } = await this.supabase.client
      .from('items')
      .select('type,status')
      .eq('reported_by', userId)
      .returns<Array<Pick<Item, 'type' | 'status'>>>();

    if (error) {
      throw new Error(SupabaseService.message(error));
    }
    const rows = data ?? [];
    return {
      lost: rows.filter((row) => row.type === 'lost').length,
      found: rows.filter((row) => row.type === 'found').length,
      active: rows.filter((row) => row.status === 'active' || row.status === 'matched').length,
      returned: rows.filter((row) => row.status === 'returned').length,
      closed: rows.filter((row) => row.status === 'closed' || row.status === 'rejected').length,
    };
  }

  /* ------------------------------------------------------------------ */
  /* reporter hydration                                                 */
  /* ------------------------------------------------------------------ */

  /** Add only the public reporter name and role; e-mail/phone remain private. */
  async attachReporters(rows: Item[]): Promise<ItemWithReporter[]> {
    if (rows.length === 0) {
      return [];
    }

    const ids = [...new Set(rows.map((row) => row.reported_by))];
    const { data, error } = await this.supabase.client
      .from('profiles_public')
      .select('user_id, full_name, role, campus_role')
      .in('user_id', ids)
      .returns<PublicProfile[]>();

    if (error) {
      return rows.map((row) => ({ ...row, reporter: null }));
    }

    const byId = new Map((data ?? []).map((profile) => [profile.user_id, profile]));
    return rows.map((row) => ({ ...row, reporter: byId.get(row.reported_by) ?? null }));
  }

  /** Fetch several items by id, hydrated — used by matches and claims. */
  async getManyByIds(ids: string[]): Promise<Map<string, ItemWithReporter>> {
    if (ids.length === 0) {
      return new Map();
    }
    const { data, error } = await this.supabase.client
      .from('items')
      .select('*')
      .in('id', ids)
      .returns<Item[]>();

    if (error) {
      throw new Error(SupabaseService.message(error));
    }
    const hydrated = await this.attachReporters(data ?? []);
    return new Map(hydrated.map((item) => [item.id, item]));
  }
}
