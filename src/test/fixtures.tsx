import { render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from '@/App';
import type { BrandRole, BrandRow, OrgKind, OrgRole } from '@/lib/database.types';
import { fake, makeUser } from './fakeSupabase';

export const ME = makeUser({ id: 'user-me', email: 'yo@example.com', fullName: 'Yo Mismo' });
export const ORG_ID = 'org-1';
export const BRAND_ID = 'brand-1';
export const BASE = `/o/${ORG_ID}`;
export const BRAND_BASE = `${BASE}/m/${BRAND_ID}`;

export function brandRow(overrides: Partial<BrandRow> = {}): BrandRow {
  return {
    id: BRAND_ID,
    organization_id: ORG_ID,
    name: 'Casa Demo',
    sector: 'Restauración',
    website: 'https://casademo.example',
    timezone: 'Europe/Madrid',
    default_locale: 'es',
    status: 'active',
    ai_mode: 'api',
    created_by: null,
    created_at: '2026-10-01T09:00:00Z',
    updated_at: '2026-10-01T09:00:00Z',
    ...overrides,
  };
}

export interface Workspace {
  orgRole: OrgRole;
  /** Rol en la marca (solo cuenta para los miembros: owner y admin gestionan todas). */
  brandRole?: BrandRole;
  kind?: OrgKind;
  /** Marcas visibles para el usuario (la RLS ya las ha filtrado). */
  brands?: BrandRow[];
  platformAdmin?: boolean;
}

/** Deja en la base simulada una organización con una marca y al usuario con el rol indicado. */
export function seedWorkspace({ orgRole, brandRole, kind = 'business', brands, platformAdmin = false }: Workspace) {
  fake.signIn(ME);
  fake.tables.organizations = [
    {
      id: ORG_ID,
      name: 'Grupo Demo',
      kind,
      settings: {},
      created_by: null,
      created_at: '2026-10-01T09:00:00Z',
      updated_at: '2026-10-01T09:00:00Z',
    },
  ];
  fake.tables.organization_members = [
    { organization_id: ORG_ID, user_id: ME.id, role: orgRole, created_at: '2026-10-01T09:00:00Z' },
  ];
  fake.tables.brands = brands ?? [brandRow()];
  fake.tables.brand_members = brandRole
    ? [
        {
          brand_id: BRAND_ID,
          organization_id: ORG_ID,
          user_id: ME.id,
          role: brandRole,
          created_at: '2026-10-01T09:00:00Z',
        },
      ]
    : [];
  fake.tables.profiles = [{ user_id: ME.id, email: ME.email, full_name: 'Yo Mismo', locale: 'es' }];
  fake.tables.platform_admins = platformAdmin ? [{ user_id: ME.id }] : [];
}

/** Añade a otra persona a la organización (y, si se indica, a la marca). */
export function addPerson(id: string, name: string, orgRole: OrgRole, brandRole?: BrandRole) {
  fake.rows('profiles').push({ user_id: id, email: `${id}@example.com`, full_name: name, locale: 'es' });
  fake.rows('organization_members').push({
    organization_id: ORG_ID,
    user_id: id,
    role: orgRole,
    created_at: '2026-10-02T09:00:00Z',
  });
  if (brandRole)
    fake.rows('brand_members').push({
      brand_id: BRAND_ID,
      organization_id: ORG_ID,
      user_id: id,
      role: brandRole,
      created_at: '2026-10-02T09:00:00Z',
    });
}

/** Monta la aplicación entera en esa ruta, con su enrutado, su carga perezosa y sus redirecciones reales. */
export function renderApp(path: string) {
  window.history.pushState({}, '', path);
  // Sin `applyAccept` la prueba decide qué archivos llegan al control (la app valida después).
  const user = userEvent.setup({ applyAccept: false });
  return { user, ...render(<App />) };
}
