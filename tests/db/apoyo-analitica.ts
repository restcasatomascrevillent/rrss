// Apoyo para las pruebas de la analítica (Fase 5): conectar una cuenta con la
// Graph API simulada, publicar de verdad con el publicador de la Fase 3 y
// llamar a las funciones del servidor como lo hace supabase-js.
import type { RpcClient } from '../../supabase/functions/_shared/ai/contract.ts';
import type { ClaimedSocialJob } from '../../supabase/functions/_shared/social/contract.ts';
import { encryptToken, parseKeyRing, tokenBinding } from '../../supabase/functions/_shared/social/crypto.ts';
import { createMetaGraph } from '../../supabase/functions/_shared/social/meta-graph.ts';
import { processPublishJob } from '../../supabase/functions/_shared/social/publisher.ts';
import { SIMULATED_IG_USER_ID, type SimulatedGraph } from '../../supabase/functions/_shared/social/simulated-graph.ts';
import { as, asService, assetPath, type Db, type TestUser } from './helpers';

export const KEYS = parseKeyRing(`k1:${Buffer.alloc(32, 9).toString('base64')}`, 'k1');
export const PUBLISH_WORKER = 'pruebas:social-publish';

const toParams = (args: Record<string, unknown>) => {
  const names = Object.keys(args).filter((n) => args[n] !== undefined);
  return {
    list: names.map((n, i) => `${n} => $${i + 1}`).join(', '),
    params: names.map((n) => {
      const v = args[n];
      return typeof v === 'object' && v !== null && !Array.isArray(v) ? JSON.stringify(v) : v;
    }),
  };
};

const DOC = (caption: string) => ({
  schemaVersion: 1,
  canvas: { aspectRatio: '1:1', width: 1080, height: 1080, backgroundColor: '#FFFFFF' },
  layers: [],
  copy: { caption, hashtags: [], mentions: [], altText: 'Texto alternativo', callToAction: { label: '', url: '' } },
});

export function socialKit(db: Db) {
  /** Llama a una función como lo haría supabase-js con la clave de servicio. */
  async function serviceCall(fn: string, args: Record<string, unknown>): Promise<unknown> {
    const [meta] = await db.query<{ retset: boolean }>(
      `select bool_or(proretset) as retset from pg_proc where proname = $1 and pronamespace = 'public'::regnamespace`,
      [fn],
    );
    const { list, params } = toParams(args);
    const sql = meta?.retset
      ? `select coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb) as data from public.${fn}(${list}) r`
      : `select to_jsonb(public.${fn}(${list})) as data`;
    const rows = await asService<{ data: unknown }>(db, sql, params);
    return rows[0]?.data ?? null;
  }

  const rpc: RpcClient = async (fn, args) => {
    try {
      return { data: await serviceCall(fn, args), error: null };
    } catch (error) {
      const { code, message, detail } = error as { code?: string; message: string; detail?: string };
      return { data: null, error: { code, message, details: detail ?? null } };
    }
  };

  async function connect(owner: TestUser, brand: string, token: string, externalId = SIMULATED_IG_USER_ID) {
    const access = await encryptToken(KEYS, token, tokenBinding({ brandId: brand, network: 'instagram', externalId }));
    const account = (await serviceCall('social_account_connect', {
      p_user_id: owner.id,
      p_brand_id: brand,
      p_network: 'instagram',
      p_external_id: externalId,
      p_username: 'cuenta_simulada',
      p_display_name: 'Cuenta simulada',
      p_page_id: '1',
      p_scopes: ['instagram_basic', 'instagram_content_publish', 'instagram_manage_insights'],
      p_token_expires_at: null,
      p_key_id: access.keyId,
      p_access_token_ciphertext: access.ciphertext,
      p_refresh_token_ciphertext: null,
    })) as { id: string };
    return account.id;
  }

  /** Pieza aprobada con su exportación (o un vídeo, si es un reel), programada en la cuenta. */
  async function schedulePiece(
    p: { owner: TestUser; editor: TestUser; org: string; brand: string; account: string },
    opts: { format?: 'post' | 'reel'; caption?: string; title?: string } = {},
  ): Promise<string> {
    const format = opts.format ?? 'post';
    const [item] = await as<{ id: string }>(
      db,
      p.editor,
      `insert into public.content_items (brand_id, organization_id, title, network, format)
       values ($1, $2, $3, 'instagram', $4) returning id`,
      [p.brand, p.org, opts.title ?? 'Pieza', format],
    );
    const contentId = item!.id;
    await as(db, p.owner, `select public.save_content_version($1, $2::jsonb, 1)`, [
      contentId,
      JSON.stringify(DOC(opts.caption ?? `Texto ${contentId}`)),
    ]);
    const [asset] =
      format === 'reel'
        ? await as<{ id: string }>(
            db,
            p.editor,
            `insert into public.media_assets (brand_id, organization_id, kind, storage_path, file_name, mime_type, bytes)
             values ($1, $2, 'video', $3, 'reel.mp4', 'video/mp4', 100) returning id`,
            [p.brand, p.org, assetPath(p.org, p.brand, `${crypto.randomUUID()}.mp4`)],
          )
        : await as<{ id: string }>(
            db,
            p.editor,
            `insert into public.media_assets (brand_id, organization_id, kind, storage_path, file_name, mime_type, bytes, provenance)
             values ($1, $2, 'image', $3, 'exportada.jpg', 'image/jpeg', 100, $4::jsonb) returning id`,
            [
              p.brand,
              p.org,
              assetPath(p.org, p.brand),
              JSON.stringify({ type: 'export', content_id: contentId, version: 1, unsaved_changes: false }),
            ],
          );
    await as(db, p.owner, `select public.set_content_status($1, 'approved', 1)`, [contentId]);
    const { list, params } = toParams({
      p_publication_id: null,
      p_content_id: contentId,
      p_scheduled_at: new Date(Date.now() + 3_600_000).toISOString(),
      p_social_account_id: p.account,
      p_media_asset_ids: [asset!.id],
    });
    const [row] = await as<{ data: { id: string } }>(
      db,
      p.editor,
      `select to_jsonb(r) as data from public.save_publication(${list}) r`,
      params,
    );
    const id = row!.data.id;
    await db.query(
      `update public.scheduled_publications set scheduled_at = now() - interval '1 second' where id = $1`,
      [id],
    );
    return id;
  }

  /** Una pasada del publicador de la Fase 3 contra la Graph API simulada. */
  async function publishDue(graph: SimulatedGraph) {
    await serviceCall('social_enqueue_due_publications', { p_limit: 100 });
    const jobs = (await serviceCall('claim_jobs', {
      p_worker: PUBLISH_WORKER,
      p_kinds: ['social.publish'],
      p_limit: 20,
      p_lease_seconds: 300,
    })) as ClaimedSocialJob[];
    const results = [];
    for (const job of jobs) {
      results.push(
        await processPublishJob(job, {
          rpc,
          api: createMetaGraph({ fetch: graph.fetch }),
          keyRing: KEYS,
          signedUrl: async (path) => `https://almacen.pruebas.invalid/firmada/${path}`,
          workerName: PUBLISH_WORKER,
          sleep: async () => undefined,
          pollIntervalMs: 0,
        }),
      );
    }
    return results;
  }

  return { serviceCall, rpc, connect, schedulePiece, publishDue };
}
