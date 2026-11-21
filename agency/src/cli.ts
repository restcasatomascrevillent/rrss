// Línea de órdenes de la agencia (la arranca main.ts). Se ejecuta con:
//   npm run agencia -- <orden> [argumentos]
// (equivale a `node --import ./src/register.ts src/main.ts …` desde agency/).
import path from 'node:path';
import {
  CommandError,
  checkFile,
  checkId,
  checkPlan,
  comment,
  context,
  deliver,
  deliverCampaignPlan,
  pending,
  release,
  take,
  type CheckOutcome,
} from './commands.ts';
import { checkTemplatesFile, deliverTemplates, importedBrands, importedContext, TemplatesError } from './templates.ts';
import { ConfigError, loadCredentials, resolveConfig } from './config.ts';
import { ApiError, createClient, type SupabaseClient } from './supabase.ts';
import type { BrandCheckResult } from '../../src/features/brandcheck/types.ts';

const HELP = `Herramienta de la agencia (rrss)

Órdenes:
  pendientes [--json]                 Encargos de las marcas que la cuenta puede editar
  tomar <id> [--renovar]              Toma un encargo (cerrojo); --renovar alarga el propio
  contexto <id>                       Escribe en la carpeta de trabajo el encargo, el perfil
                                      de marca, los límites de la red y los recursos
  comprobar <entrega.json> [--contexto <carpeta>] [--json]
                                      Valida la entrega y pasa el verificador de marca (sin red)
  entregar <id> <entrega.json> [--aun-con-bloqueos]
                                      Crea la pieza en borrador y marca el encargo entregado
  comprobar-plan <plan.json> [--contexto <carpeta>]
                                      Valida un plan de campaña (encargo de tipo «plan»), sin red
  entregar-plan <id> <plan.json>      Entrega el plan; el cliente lo revisa y lo acepta en Campañas
  importadas [<marca>] [--descargar] [--limite N] [--json]
                                      Sin marca: las marcas con publicaciones importadas de Instagram.
                                      Con marca: deja en la carpeta de trabajo lo importado, su resumen,
                                      el perfil y la biblioteca (y con --descargar, las imágenes
                                      más recientes) para sacar sus plantillas de diseño
  comprobar-plantillas <plantillas.json> [--manual]
                                      Valida las plantillas (documento v3, formato, análisis), sin red
  entregar-plantillas <marca> <plantillas.json> [--manual]
                                      Las guarda como plantillas de la marca. --manual: para una marca
                                      sin cuenta conectada; llevan «references» en vez de «examples»
  comentar <id> <texto>               Añade un comentario al encargo
  soltar <id>                         Devuelve un encargo tomado a la cola

Variables:
  RRSS_AGENCIA_CREDENCIALES   archivo de credenciales (por defecto ~/.rrss-agencia/credenciales.json)
  RRSS_AGENCIA_TRABAJO        carpeta de trabajo (por defecto ~/.rrss-agencia/trabajo)
  RRSS_AGENCIA_CERROJO_MINUTOS duración del cerrojo al tomar (por defecto 240)
`;

interface Output {
  log(text: string): void;
  error(text: string): void;
}

function parseArgs(argv: string[]): { positional: string[]; flags: Map<string, string | true> } {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--contexto') {
      flags.set('contexto', argv[++i] ?? '');
    } else if (arg.startsWith('--')) {
      flags.set(arg.slice(2), true);
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

function formatCheck(result: BrandCheckResult, label: string): string {
  const verdict = { pass: 'apta', pass_with_warnings: 'apta con avisos', fail: 'NO apta (bloqueos)' }[result.verdict];
  const lines = [
    `${label}: ${verdict} · ${result.counts.block} bloqueos, ${result.counts.warn} avisos, ${result.counts.info} notas`,
  ];
  const icon = { block: '✗', warn: '!', info: '·' } as const;
  for (const finding of result.findings) lines.push(`  ${icon[finding.severity]} ${finding.message}`);
  return lines.join('\n');
}

function formatOutcome(outcome: CheckOutcome): string {
  const blocks = [formatCheck(outcome.main, 'Pieza')];
  outcome.variants.forEach((variant, index) => blocks.push(formatCheck(variant, `Variante ${index + 2}`)));
  return blocks.join('\n\n');
}

async function signedInClient(env: NodeJS.ProcessEnv): Promise<SupabaseClient> {
  const config = resolveConfig(env);
  const credentials = await loadCredentials(config.credentialsPath);
  const client = createClient({ url: credentials.url, anonKey: credentials.anonKey });
  await client.signIn(credentials.email, credentials.password);
  return client;
}

/** Ejecuta una orden. Devuelve el código de salida. */
export async function run(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
  out: Output = { log: (t) => console.log(t), error: (t) => console.error(t) },
): Promise<number> {
  const [command, ...rest] = argv;
  const { positional, flags } = parseArgs(rest);
  const config = resolveConfig(env);
  try {
    switch (command) {
      case 'pendientes': {
        const items = await pending(await signedInClient(env));
        if (flags.has('json')) {
          out.log(JSON.stringify(items, null, 2));
        } else if (!items.length) {
          out.log('No hay encargos pendientes.');
        } else {
          for (const item of items) {
            const when = item.desiredDate ? ` · para el ${item.desiredDate}` : '';
            const mine = item.takenByMe ? ' · tomado por esta cuenta' : '';
            out.log(
              `${item.id}  [${item.status}] ${item.brand} · ${item.network}/${item.format}${when}${mine}\n    ${item.title}`,
            );
          }
        }
        return 0;
      }
      case 'tomar': {
        const id = checkId(positional[0]);
        const row = await take(await signedInClient(env), config.workDir, id, {
          renew: flags.has('renovar'),
          leaseMinutes: config.leaseMinutes,
        });
        out.log(`Encargo ${row.id} tomado hasta ${row.claimed_until}. Siguiente paso: contexto ${row.id}`);
        return 0;
      }
      case 'contexto': {
        const id = checkId(positional[0]);
        const result = await context(await signedInClient(env), config.workDir, id);
        out.log(`Contexto escrito en ${result.dir}:\n${result.files.map((f) => `  - ${f}`).join('\n')}`);
        out.log(`Prepara la entrega en ${path.join(result.dir, 'entrega.json')} y compruébala con «comprobar».`);
        return 0;
      }
      case 'comprobar': {
        const file = positional[0];
        if (!file) throw new CommandError('Indica el archivo de entrega.');
        const contextDir = typeof flags.get('contexto') === 'string' ? (flags.get('contexto') as string) : undefined;
        const outcome = await checkFile(path.resolve(file), contextDir ? path.resolve(contextDir) : undefined);
        if (flags.has('json')) {
          out.log(
            JSON.stringify({ main: outcome.main, variants: outcome.variants, document: outcome.document }, null, 2),
          );
        } else {
          out.log(formatOutcome(outcome));
        }
        return outcome.main.verdict === 'fail' ? 1 : 0;
      }
      case 'entregar': {
        const id = checkId(positional[0]);
        const file = positional[1];
        if (!file) throw new CommandError('Indica el archivo de entrega.');
        const result = await deliver(await signedInClient(env), config.workDir, id, path.resolve(file), {
          allowBlocking: flags.has('aun-con-bloqueos'),
        });
        out.log(formatCheck(result.check, 'Verificador'));
        out.log(
          `Entregado: pieza ${result.request.content_id}, versión ${result.request.delivered_version}, en borrador. El cliente ya puede revisarla.`,
        );
        return 0;
      }
      case 'comprobar-plan': {
        const file = positional[0];
        if (!file) throw new CommandError('Indica el archivo del plan.');
        const contextDir = typeof flags.get('contexto') === 'string' ? (flags.get('contexto') as string) : undefined;
        const checked = await checkPlan(path.resolve(file), contextDir ? path.resolve(contextDir) : undefined);
        out.log(`Plan válido: ${checked.plan.pieces.length} piezas.`);
        return 0;
      }
      case 'entregar-plan': {
        const id = checkId(positional[0]);
        const file = positional[1];
        if (!file) throw new CommandError('Indica el archivo del plan.');
        const result = await deliverCampaignPlan(await signedInClient(env), config.workDir, id, path.resolve(file));
        out.log(
          `Plan entregado (versión ${result.request.delivered_plan_version}, ${result.pieces} piezas). El cliente lo revisa en Campañas; al aceptarlo, las piezas se crean como borradores.`,
        );
        return 0;
      }
      case 'importadas': {
        const client = await signedInClient(env);
        if (!positional[0]) {
          const brands = await importedBrands(client);
          if (flags.has('json')) out.log(JSON.stringify(brands, null, 2));
          else if (!brands.length) out.log('Ninguna marca tiene publicaciones importadas.');
          else {
            for (const b of brands) out.log(`${b.brandId}  ${b.name} · ${b.imported} publicaciones importadas`);
          }
          return 0;
        }
        const limitFlag = flags.get('limite');
        const result = await importedContext(client, config.workDir, checkId(positional[0]), {
          download: flags.has('descargar'),
          limit:
            typeof limitFlag === 'string'
              ? Math.max(1, Math.min(Number.parseInt(limitFlag, 10) || 40, 200))
              : undefined,
        });
        const lines = [
          `${result.total} publicaciones importadas. Material escrito en ${result.dir}:`,
          ...result.files.map((f) => `  - ${f}`),
        ];
        if (flags.has('descargar')) {
          lines.push(`Imágenes descargadas: ${result.downloaded} (sin imagen o caducadas: ${result.skipped}).`);
        }
        out.log(lines.join('\n'));
        out.log(
          `Prepara las plantillas en ${path.join(result.dir, 'plantillas.json')} y compruébalas con «comprobar-plantillas».`,
        );
        return 0;
      }
      case 'comprobar-plantillas': {
        const file = positional[0];
        if (!file) throw new CommandError('Indica el archivo de plantillas.');
        const checked = await checkTemplatesFile(path.resolve(file), { manual: flags.has('manual') });
        out.log(
          `Plantillas válidas: ${checked.templates.map((t) => `${t.key} (${t.network}/${t.format})`).join(', ')}.`,
        );
        return 0;
      }
      case 'entregar-plantillas': {
        const brandId = checkId(positional[0]);
        const file = positional[1];
        if (!file) throw new CommandError('Indica el archivo de plantillas.');
        const result = await deliverTemplates(await signedInClient(env), brandId, path.resolve(file), {
          manual: flags.has('manual'),
        });
        out.log(
          `Plantillas guardadas en la marca: ${result.delivered.map((t) => `${t.template_key} («${t.name}»)`).join(', ')}.`,
        );
        return 0;
      }
      case 'comentar': {
        const id = checkId(positional[0]);
        await comment(await signedInClient(env), id, positional.slice(1).join(' '));
        out.log('Comentario añadido.');
        return 0;
      }
      case 'soltar': {
        const id = checkId(positional[0]);
        const row = await release(await signedInClient(env), config.workDir, id);
        out.log(`Encargo ${row.id} devuelto a la cola («${row.status}»).`);
        return 0;
      }
      case undefined:
      case 'ayuda':
      case '--help':
        out.log(HELP);
        return command === undefined ? 2 : 0;
      default:
        out.error(`Orden desconocida: ${command}\n\n${HELP}`);
        return 2;
    }
  } catch (error) {
    if (error instanceof CommandError || error instanceof ConfigError || error instanceof TemplatesError) {
      out.error(error.message);
      return 2;
    }
    if (error instanceof ApiError) {
      out.error(error.code ? `${error.message} (código ${error.code})` : error.message);
      return 1;
    }
    throw error;
  }
}
