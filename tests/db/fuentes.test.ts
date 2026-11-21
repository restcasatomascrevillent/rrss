// Texto de las fuentes de conocimiento (migración 20261119210000): al dar de
// alta una fuente se encola `source.extract`; el estado del trabajo llega a la
// fuente y el texto del resultado se mueve a la fuente (no se queda en jobs).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  as,
  createBrand,
  createDb,
  createOrg,
  createUser,
  denied,
  join,
  rpcStatement,
  serviceRpc,
  asService,
  type Db,
  type Row,
  type TestUser,
} from './helpers';

interface SourceRow extends Row {
  id: string;
  status: string;
  error: string | null;
  extracted_text: string | null;
  extracted_chars: number | null;
  extraction: Row | null;
  extraction_job_id: string | null;
}

interface JobRow extends Row {
  id: string;
  kind: string;
  status: string;
  brand_id: string;
  payload: Row;
  result: Row | null;
  created_by: string | null;
}

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

let db: Db;
let ana: TestUser, editor: TestUser, berta: TestUser;
let orgA: string, orgB: string, marcaA: string, marcaB: string;

beforeAll(async () => {
  db = await createDb();
  ana = await createUser(db, 'ana@a.test');
  editor = await createUser(db, 'editor@a.test');
  berta = await createUser(db, 'berta@b.test');
  orgA = await createOrg(db, ana, 'Empresa A');
  orgB = await createOrg(db, berta, 'Empresa B');
  marcaA = await createBrand(db, ana, orgA, 'Marca A');
  marcaB = await createBrand(db, berta, orgB, 'Marca B');
  await join(db, ana, editor, orgA, 'member', marcaA, 'editor');
});
afterAll(async () => {
  await db?.close();
});

let n = 0;
async function addFile(user: TestUser, org: string, brand: string, kind: string, mime: string): Promise<string> {
  n += 1;
  const [row] = await as<{ id: string }>(
    db,
    user,
    `insert into public.brand_knowledge_sources (brand_id, organization_id, kind, title, storage_path, mime_type, bytes)
     values ($1, $2, $3::public.source_kind, $4, $5, $6, 100) returning id`,
    [brand, org, kind, `Fuente ${n}`, `${org}/${brand}/sources/f${n}`, mime],
  );
  return row!.id;
}

async function addWeb(user: TestUser, org: string, brand: string, url: string): Promise<string> {
  const [row] = await as<{ id: string }>(
    db,
    user,
    `insert into public.brand_knowledge_sources (brand_id, organization_id, kind, title, url)
     values ($1, $2, 'website', 'Web', $3) returning id`,
    [brand, org, url],
  );
  return row!.id;
}

const source = async (id: string) =>
  (await db.query<SourceRow>(`select * from public.brand_knowledge_sources where id = $1`, [id]))[0]!;
const job = async (id: string) => (await db.query<JobRow>(`select * from public.jobs where id = $1`, [id]))[0]!;

async function claim(worker = 'w1'): Promise<JobRow[]> {
  const { sql, params } = rpcStatement('claim_jobs', { p_worker: worker, p_kinds: ['source.extract'], p_limit: 10 });
  return (await asService<{ data: JobRow }>(db, sql, params)).map((r) => r.data);
}

describe('encolar la extracción al dar de alta una fuente', () => {
  it('PDF, Word, texto, JSON y web quedan pendientes con su trabajo', async () => {
    const pdf = await addFile(ana, orgA, marcaA, 'pdf', 'application/pdf');
    const docx = await addFile(ana, orgA, marcaA, 'document', DOCX);
    const txt = await addFile(ana, orgA, marcaA, 'text', 'text/plain');
    const json = await addFile(ana, orgA, marcaA, 'json', 'application/json');
    const web = await addWeb(ana, orgA, marcaA, 'https://marca-a.test/');
    const expected: Record<string, Row> = {
      [pdf]: { format: 'pdf', path: `${orgA}/${marcaA}/sources/f1` },
      [docx]: { format: 'docx' },
      [txt]: { format: 'text' },
      [json]: { format: 'text' },
      [web]: { format: 'website', url: 'https://marca-a.test/' },
    };
    for (const [id, payload] of Object.entries(expected)) {
      const row = await source(id);
      expect(row.status, id).toBe('pending');
      const queued = await job(row.extraction_job_id!);
      expect(queued).toMatchObject({ kind: 'source.extract', status: 'queued', brand_id: marcaA, created_by: ana.id });
      expect(queued.payload).toMatchObject({ source_id: id, ...payload });
    }
  });

  it('de imágenes y presentaciones no se extrae: queda fallida con el motivo, sin trabajo', async () => {
    const image = await addFile(ana, orgA, marcaA, 'image', 'image/png');
    const pptx = await addFile(
      ana,
      orgA,
      marcaA,
      'document',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    );
    expect(await source(image)).toMatchObject({ status: 'failed', extraction_job_id: null });
    expect((await source(image)).error).toMatch(/imágenes no se extrae/);
    expect((await source(pptx)).error).toMatch(/Se admiten PDF, Word/);
  });
});

describe('del trabajo a la fuente', () => {
  it('en curso → extrayendo; terminado → lista con el texto, que sale del resultado del trabajo', async () => {
    await db.exec(`update public.jobs set status = 'cancelled', finished_at = now() where status = 'queued'`);
    const id = await addFile(ana, orgA, marcaA, 'pdf', 'application/pdf');
    const [claimed] = await claim();
    expect(claimed!.payload.source_id).toBe(id);
    expect((await source(id)).status).toBe('processing');

    const done = await serviceRpc<JobRow>(db, 'complete_job', {
      p_job_id: claimed!.id,
      p_worker: 'w1',
      p_result: { text: 'Somos una panadería de barrio', meta: { format: 'pdf', pages: 2, truncated: false } },
    });
    expect(done.result).toEqual({ meta: { format: 'pdf', pages: 2, truncated: false }, chars: 29 });
    expect(await source(id)).toMatchObject({
      status: 'ready',
      error: null,
      extracted_text: 'Somos una panadería de barrio',
      extracted_chars: 29,
      extraction: { format: 'pdf', pages: 2, truncated: false },
    });
  });

  it('un fallo pasajero la deja pendiente con el aviso; el definitivo, fallida con el motivo', async () => {
    const id = await addWeb(ana, orgA, marcaA, 'https://lenta.test/');
    let [claimed] = await claim();
    await serviceRpc(db, 'fail_job', {
      p_job_id: claimed!.id,
      p_worker: 'w1',
      p_error: 'Tiempo agotado',
      p_retry: true,
    });
    expect(await source(id)).toMatchObject({ status: 'pending', error: 'Se reintentará: Tiempo agotado' });

    await db.exec(`update public.jobs set run_after = now() where id = '${claimed!.id}'`);
    [claimed] = await claim();
    await serviceRpc(db, 'fail_job', {
      p_job_id: claimed!.id,
      p_worker: 'w1',
      p_error: 'robots.txt no permite leerla',
      p_retry: false,
    });
    expect(await source(id)).toMatchObject({ status: 'failed', error: 'robots.txt no permite leerla' });
  });

  it('sin texto en el resultado queda fallida; un trabajo antiguo no pisa el estado', async () => {
    const id = await addFile(ana, orgA, marcaA, 'text', 'text/plain');
    const [first] = await claim();
    await serviceRpc(db, 'complete_job', { p_job_id: first!.id, p_worker: 'w1', p_result: { meta: {} } });
    expect(await source(id)).toMatchObject({ status: 'failed', error: 'El trabajador no ha devuelto texto.' });

    // Se vuelve a pedir; el trabajo anterior ya no manda.
    const [again] = await as<SourceRow>(db, ana, `select * from public.request_source_extraction($1)`, [id]);
    expect(again!.status).toBe('pending');
    expect(again!.extraction_job_id).not.toBe(first!.id);
    // Un trabajo viejo de la misma fuente que terminara tarde no cambia nada.
    await db.exec(`update public.jobs set status = 'failed', last_error = 'viejo' where id = '${first!.id}'`);
    expect((await source(id)).status).toBe('pending');
  });
});

describe('volver a pedir la extracción', () => {
  it('solo quien gestiona la marca; con una en marcha devuelve la misma', async () => {
    const id = await addWeb(ana, orgA, marcaA, 'https://otra.test/');
    const before = (await source(id)).extraction_job_id;
    const [same] = await as<SourceRow>(db, ana, `select * from public.request_source_extraction($1)`, [id]);
    expect(same!.extraction_job_id).toBe(before);

    await denied(db, editor, `select public.request_source_extraction($1)`, [id], /No tienes permiso/);
    await denied(db, berta, `select public.request_source_extraction($1)`, [id], /No tienes permiso/);
    await denied(db, null, `select public.request_source_extraction($1)`, [id], /permission denied/);
  });

  it('el cliente no puede escribir el texto ni el estado', async () => {
    const id = await addWeb(ana, orgA, marcaA, 'https://tercera.test/');
    await denied(db, ana, `update public.brand_knowledge_sources set extracted_text = 'inventado' where id = $1`, [id]);
    await denied(db, ana, `update public.brand_knowledge_sources set status = 'ready' where id = $1`, [id]);
    await denied(
      db,
      ana,
      `insert into public.brand_knowledge_sources (brand_id, organization_id, kind, title, url, extracted_text)
       values ($1, $2, 'website', 'X', 'https://x.test', 'inventado')`,
      [marcaA, orgA],
    );
  });

  it('cada organización ve solo el texto de sus fuentes', async () => {
    const idB = await addWeb(berta, orgB, marcaB, 'https://marca-b.test/');
    expect(await as(db, ana, `select extracted_text from public.brand_knowledge_sources where id = $1`, [idB])).toEqual(
      [],
    );
    expect(
      await as(db, berta, `select 1 from public.jobs where kind = 'source.extract' and brand_id = $1`, [marcaA]),
    ).toEqual([]);
  });
});
