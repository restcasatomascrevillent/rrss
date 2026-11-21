import { describe, expect, it } from 'vitest';
import { parseRights, rightsExpired, serializeRights } from '@/features/library/labels';
import { likePattern } from '@/features/library/api';
import { describeAudit } from './describe';

const names = (id: string) => (id === 'u1' ? 'Ana' : '');

describe('describeAudit', () => {
  it('redacta las acciones habituales', () => {
    expect(describeAudit({ action: 'insert', entity_type: 'brands', data: { name: 'Uno' } }, names)).toBe(
      'creó la marca «Uno»',
    );
    expect(
      describeAudit({ action: 'update', entity_type: 'brands', data: { name: 'Uno', status: 'archived' } }, names),
    ).toBe('archivó la marca «Uno»');
    expect(
      describeAudit(
        { action: 'insert', entity_type: 'organization_members', data: { user_id: 'u1', role: 'admin' } },
        names,
      ),
    ).toBe('añadió a Ana como Administrador');
    expect(
      describeAudit({ action: 'update', entity_type: 'brand_members', data: { user_id: 'u1', role: 'client' } }, names),
    ).toBe('cambió el rol de Ana a Cliente');
    expect(describeAudit({ action: 'insert', entity_type: 'brand_profiles', data: { version: 3 } }, names)).toBe(
      'guardó la versión 3 del perfil de marca',
    );
    expect(describeAudit({ action: 'delete', entity_type: 'media_assets', data: { file_name: 'a.jpg' } }, names)).toBe(
      'eliminó el archivo «a.jpg»',
    );
  });

  it('distingue invitación aceptada, anulada y creada', () => {
    expect(describeAudit({ action: 'insert', entity_type: 'invitations', data: { email: 'x@y.z' } }, names)).toBe(
      'invitó a x@y.z',
    );
    expect(
      describeAudit(
        { action: 'update', entity_type: 'invitations', data: { email: 'x@y.z', accepted_at: '2026-01-01' } },
        names,
      ),
    ).toMatch(/aceptó/);
    expect(
      describeAudit(
        { action: 'update', entity_type: 'invitations', data: { email: 'x@y.z', revoked_at: '2026-01-01' } },
        names,
      ),
    ).toMatch(/anuló/);
  });

  it('al aceptar una invitación dice una sola línea y no «Ana dio acceso a Ana»', () => {
    const via = { via: 'invitation' };
    // Altas que trae consigo la aceptación: no se repiten.
    expect(
      describeAudit(
        {
          action: 'insert',
          entity_type: 'brand_members',
          actor_id: 'u1',
          data: { user_id: 'u1', role: 'editor', ...via },
        },
        names,
      ),
    ).toBeNull();
    expect(
      describeAudit(
        {
          action: 'insert',
          entity_type: 'organization_members',
          actor_id: 'u1',
          data: { user_id: 'u1', role: 'member', ...via },
        },
        names,
      ),
    ).toBeNull();
    // La línea que lo cuenta, con el rol de la marca o, si no hay marca, el de la organización.
    expect(
      describeAudit(
        {
          action: 'update',
          entity_type: 'invitations',
          data: {
            email: 'x@y.z',
            accepted_at: '2026-01-01',
            brand_id: 'b1',
            brand_role: 'editor',
            org_role: 'member',
            ...via,
          },
        },
        names,
      ),
    ).toBe('aceptó la invitación y entró como Editor');
    expect(
      describeAudit(
        {
          action: 'update',
          entity_type: 'invitations',
          data: { email: 'x@y.z', accepted_at: '2026-01-01', brand_id: null, brand_role: null, org_role: 'admin' },
        },
        names,
      ),
    ).toBe('aceptó la invitación y entró en la organización como Administrador');
    // Registros antiguos (sin la marca): tampoco «Ana dio acceso a Ana».
    expect(
      describeAudit(
        { action: 'insert', entity_type: 'brand_members', actor_id: 'u1', data: { user_id: 'u1', role: 'editor' } },
        names,
      ),
    ).toBe('entró en la marca como Editor');
    // Dar acceso a otra persona se sigue contando igual.
    expect(
      describeAudit(
        { action: 'insert', entity_type: 'brand_members', actor_id: 'u2', data: { user_id: 'u1', role: 'editor' } },
        names,
      ),
    ).toBe('dio acceso a Ana como Editor');
  });

  it('no revienta con usuarios desconocidos, datos raros o tablas nuevas', () => {
    expect(
      describeAudit({ action: 'delete', entity_type: 'organization_members', data: { user_id: 'otro' } }, names),
    ).toBe('quitó a un usuario de la organización');
    expect(describeAudit({ action: 'insert', entity_type: 'brands', data: null }, names)).toBe('creó la marca «»');
    expect(describeAudit({ action: 'insert', entity_type: 'tabla_futura', data: [] }, names)).toBe('hizo un cambio');
    expect(describeAudit({ action: 'update', entity_type: 'social_accounts', data: {} }, names)).toBe(
      'cambió una cuenta de red social',
    );
  });
});

describe('derechos de uso', () => {
  it('lee con valores por defecto y guarda solo lo rellenado', () => {
    expect(parseRights(null)).toEqual({ license: '', owner: '', expires_on: '', notes: '' });
    expect(parseRights({ license: 'Propia', owner: 7 })).toEqual({
      license: 'Propia',
      owner: '',
      expires_on: '',
      notes: '',
    });
    expect(serializeRights({ license: ' Propia ', owner: '', expires_on: '', notes: ' ' })).toEqual({
      license: 'Propia',
    });
  });
  it('detecta la caducidad', () => {
    const today = new Date('2026-06-15T12:00:00Z');
    expect(rightsExpired({ ...parseRights({}), expires_on: '2026-06-14' }, today)).toBe(true);
    expect(rightsExpired({ ...parseRights({}), expires_on: '2026-06-15' }, today)).toBe(false);
    expect(rightsExpired({ ...parseRights({}), expires_on: '' }, today)).toBe(false);
    expect(rightsExpired({ ...parseRights({}), expires_on: 'mañana' }, today)).toBe(false);
  });
});

describe('likePattern', () => {
  it('escapa los comodines para buscar el texto tal cual', () => {
    expect(likePattern('100%_real\\')).toBe('%100\\%\\_real\\\\%');
    expect(likePattern('foto')).toBe('%foto%');
  });
});

describe('comentarios y campañas en la actividad', () => {
  const names = () => '';
  it('dice qué se hizo, sin nombres de tablas', () => {
    expect(
      describeAudit(
        {
          action: 'insert',
          entity_type: 'content_comments',
          data: { kind: 'comment', body: 'Chuletón al punto, cambia la foto' },
        },
        names,
      ),
    ).toBe('comentó en una publicación: «Chuletón al punto, cambia la foto»');
    expect(
      describeAudit({ action: 'insert', entity_type: 'content_comments', data: { kind: 'approved' } }, names),
    ).toBe('aprobó una publicación');
    expect(
      describeAudit(
        { action: 'update', entity_type: 'campaigns', data: { title: 'Navidad', status: 'accepted' } },
        names,
      ),
    ).toBe('actualizó la campaña «Navidad» (aceptada)');
  });
});
