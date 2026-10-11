/**
 * Shape of the application environment.
 *
 * Kept in its own file so that `environment.ts` (development) and
 * `environment.production.ts` (production build, swapped in by
 * `angular.json` → fileReplacements) can both import it without either file
 * importing the other — a self-referencing import would otherwise be created
 * by the replacement itself.
 *
 * Only PUBLIC values belong here. The Supabase anon key is designed to be
 * shipped in a browser bundle; Row Level Security is what protects the data.
 * NEVER put the service_role key in this file.
 */
export interface AppEnvironment {
  production: boolean;
  /** Your Supabase project URL, e.g. https://abcdefgh.supabase.co */
  supabaseUrl: string;
  /** The public anon key of the same project */
  supabaseAnonKey: string;
  /**
   * Optional college e-mail restriction, e.g. 'campus.edu'.
   * Leave it empty ('') to accept any e-mail domain — useful while testing.
   * When set, registration rejects addresses from other domains.
   */
  collegeEmailDomain: string;
  /** Minimum match score that is worth recording/showing (0-100) */
  matchMinScore: number;
  /** Items per page in listings */
  pageSize: number;
  appName: string;
  supportEmail: string;
}
