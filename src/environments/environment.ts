/**
 * DEVELOPMENT environment.
 *
 * Fill in `supabaseUrl` and `supabaseAnonKey` from your own Supabase project
 * (Project settings → API). The README walks through it: section
 * "Supabase setup". You can also generate this file from environment
 * variables with `node scripts/set-env.mjs`.
 *
 * Only the *public* anon key belongs here: it is designed to be embedded in a
 * browser bundle, because Row Level Security — not secrecy — protects the data.
 * NEVER put the service_role key in this file.
 */
import type { AppEnvironment } from './environment.model';

export type { AppEnvironment };

export const environment: AppEnvironment = {
  production: false,
  supabaseUrl: 'https://hpppnyymkborxfnznjlv.supabase.co',
  supabaseAnonKey: 'sb_publishable_3OktEbEZu5eXfoNHBfef9g_rvwLOnhX',
  collegeEmailDomain: 'saintgits.org', // e.g. 'examplecollege.edu'
  matchMinScore: 40,
  pageSize: 9,
  appName: 'Smart Campus Lost and Found',
  supportEmail: '',
};
