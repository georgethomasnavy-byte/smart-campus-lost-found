/**
 * PRODUCTION environment (used by `ng build` through fileReplacements).
 *
 * Replace the two placeholders with the values from your Supabase project,
 * ideally at build time:
 *
 *   SUPABASE_URL=... SUPABASE_ANON_KEY=... node scripts/set-env.mjs --production
 *
 * or set the same variables in Netlify (Site configuration → Environment
 * variables). Never commit real keys: the placeholders below are safe to
 * commit, the generated file is not.
 */
import type { AppEnvironment } from './environment.model';

export type { AppEnvironment };

export const environment: AppEnvironment = {
  production: true,
  supabaseUrl: 'YOUR_SUPABASE_URL',
  supabaseAnonKey: 'YOUR_SUPABASE_ANON_KEY',
  collegeEmailDomain: '', // e.g. 'examplecollege.edu'
  matchMinScore: 40,
  pageSize: 9,
  appName: 'Smart Campus Lost and Found',
  supportEmail: '',
};
