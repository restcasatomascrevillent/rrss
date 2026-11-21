import type { AuditLogRow, Json } from '@/lib/database.types';
import { BRAND_ROLE_LABEL, ORG_ROLE_LABEL } from '@/features/permissions/roles';
import type { BrandRole, OrgRole } from '@/lib/database.types';
import { REQUEST_STATUS_LABEL } from '@/features/requests/labels';
import type { ContentRequestStatus } from '@/lib/database.types';
import { CAMPAIGN_STATUS_TEXT, CONTENT_STATUS_TEXT, describeUnknownActivity, excerpt } from '@/lib/texts';

function str(data: Json, key: string): string {
  if (typeof data === 'object' && data !== null && !Array.isArray(data)) {
    const value = data[key];
    if (typeof value === 'string' || typeof value === 'number') return String(value);
  }
  return '';
}

/**
 * Frase en español para una fila del registro de auditoría, o `null` si la
 * fila no se muestra porque otra ya lo cuenta: al aceptar una invitación, las
 * altas de miembro que trae consigo (marcadas por el servidor con
 * `data.via = 'invitation'`) las resume la línea «aceptó la invitación y entró
 * como…».
 */
export function describeAudit(
  log: Pick<AuditLogRow, 'action' | 'entity_type' | 'data'> & { actor_id?: string | null },
  nameOf: (userId: string) => string,
): string | null {
  const { action, entity_type: entity, data } = log;
  const name = str(data, 'name');
  const who = () => nameOf(str(data, 'user_id')) || 'un usuario';
  const orgRole = (key = 'role') => ORG_ROLE_LABEL[str(data, key) as OrgRole] ?? str(data, key);
  const brandRole = (key = 'role') => BRAND_ROLE_LABEL[str(data, key) as BrandRole] ?? str(data, key);
  const viaInvitation = str(data, 'via') === 'invitation';
  // Alta de uno mismo (registros anteriores a la marca `via`, o quien se añade a sí mismo).
  const self = Boolean(log.actor_id) && log.actor_id === str(data, 'user_id');

  switch (`${entity}:${action}`) {
    case 'organizations:insert':
      return `creó la organización «${name}»`;
    case 'organizations:update':
      return `cambió los datos de la organización`;
    case 'organization_members:insert':
      if (viaInvitation) return null;
      if (self) return `entró en la organización como ${orgRole()}`;
      return `añadió a ${who()} como ${orgRole()}`;
    case 'organization_members:update':
      return `cambió el rol de ${who()} a ${orgRole()}`;
    case 'organization_members:delete':
      return `quitó a ${who()} de la organización`;
    case 'brands:insert':
      return `creó la marca «${name}»`;
    case 'brands:update':
      return str(data, 'status') === 'archived' ? `archivó la marca «${name}»` : `actualizó la marca «${name}»`;
    case 'brands:delete':
      return `eliminó la marca «${name}»`;
    case 'brand_members:insert':
      if (viaInvitation) return null;
      if (self) return `entró en la marca como ${brandRole()}`;
      return `dio acceso a ${who()} como ${brandRole()}`;
    case 'brand_members:update':
      return `cambió el rol de ${who()} a ${brandRole()}`;
    case 'brand_members:delete':
      return `quitó el acceso de ${who()} a la marca`;
    case 'brand_profiles:insert':
      return `guardó la versión ${str(data, 'version')} del perfil de marca`;
    case 'brand_knowledge_sources:insert':
      return `añadió la fuente «${str(data, 'title')}»`;
    case 'brand_knowledge_sources:delete':
      return `eliminó la fuente «${str(data, 'title')}»`;
    case 'media_assets:delete':
      return `eliminó el archivo «${str(data, 'file_name')}»`;
    case 'invitations:insert':
      return `invitó a ${str(data, 'email')}`;
    case 'invitations:update':
      if (str(data, 'accepted_at')) {
        return str(data, 'brand_id')
          ? `aceptó la invitación y entró como ${brandRole('brand_role')}`
          : `aceptó la invitación y entró en la organización como ${orgRole('org_role')}`;
      }
      if (str(data, 'revoked_at')) return `anuló la invitación de ${str(data, 'email')}`;
      return `actualizó la invitación de ${str(data, 'email')}`;
    case 'usage_quotas:insert':
      return `asignó el cupo mensual de IA`;
    case 'usage_quotas:update':
      return `cambió el cupo mensual de IA`;
    case 'usage_quotas:delete':
      return `retiró el cupo mensual de IA`;
    // Planes (Fase 6): sin importes, como el cupo.
    case 'subscriptions:insert':
      return `dio de alta la suscripción de la organización`;
    case 'subscriptions:update':
      if (str(data, 'source') === 'stripe') return `actualizó la suscripción de pago (${str(data, 'status')})`;
      if (str(data, 'source') === 'default') return `devolvió la organización al plan por defecto`;
      return `cambió el plan de la organización`;
    case 'content_items:insert':
      return `creó el contenido «${str(data, 'title')}»`;
    case 'content_items:update':
      // El registro guarda cómo quedó la fila, no qué cambió: se dice el estado en que queda.
      if (str(data, 'archived_at')) return `archivó el contenido «${str(data, 'title')}»`;
      return `actualizó el contenido «${str(data, 'title')}» (${CONTENT_STATUS_TEXT[str(data, 'status')] ?? str(data, 'status')})`;
    case 'content_items:delete':
      return `eliminó el contenido «${str(data, 'title')}»`;
    case 'content_versions:insert':
      return str(data, 'restored_from')
        ? `restauró la versión ${str(data, 'restored_from')} de un contenido (ahora es la ${str(data, 'version')})`
        : `guardó la versión ${str(data, 'version')} de un contenido`;
    case 'content_requests:insert':
      return `pidió el encargo «${str(data, 'title')}»`;
    case 'content_requests:update':
      return `actualizó el encargo «${str(data, 'title')}» (${REQUEST_STATUS_LABEL[str(data, 'status') as ContentRequestStatus]?.toLowerCase() ?? str(data, 'status')})`;
    case 'content_requests:delete':
      return `eliminó el encargo «${str(data, 'title')}»`;
    case 'content_request_comments:insert':
      return str(data, 'kind') === 'comment' ? 'comentó un encargo' : 'cambió el estado de un encargo';
    case 'content_comments:insert': {
      const kind = str(data, 'kind');
      if (kind === 'approved') return 'aprobó una publicación';
      if (kind === 'unapproved') return 'retiró la aprobación de una publicación';
      if (kind === 'changes_requested') return 'pidió cambios en una publicación';
      const body = excerpt(str(data, 'body'));
      return body ? `comentó en una publicación: «${body}»` : 'comentó en una publicación';
    }
    case 'campaigns:insert':
      return `creó la campaña «${str(data, 'title')}»`;
    case 'campaigns:update':
      return `actualizó la campaña «${str(data, 'title')}» (${CAMPAIGN_STATUS_TEXT[str(data, 'status')] ?? 'cambio de estado'})`;
    case 'campaigns:delete':
      return `eliminó la campaña «${str(data, 'title')}»`;
    default:
      // Nunca se enseña el nombre de la tabla: «hizo un cambio» si no hay frase mejor.
      return describeUnknownActivity(action, entity);
  }
}
