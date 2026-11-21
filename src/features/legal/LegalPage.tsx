import { ChevronLeft, Scale } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link, Navigate, useParams } from 'react-router-dom';
import { Badge, Notice } from '@/components/ui';
import { APP_NAME } from '@/config/app';
import { LegalFooter } from './LegalFooter';
import {
  LEGAL_DOCUMENTS,
  LEGAL_VERSIONS,
  legalPath,
  PLACEHOLDERS as P,
  PROCESSOR_STATUS_LABEL,
  PROCESSORS,
  type LegalDocumentId,
} from './legal';

// Páginas legales públicas. PLANTILLAS: los huecos entre corchetes son datos
// reales de la empresa que faltan, y un abogado debe revisar el texto antes de
// usarlo con clientes. Lo que se describe del producto (qué datos trata, dónde,
// qué guarda en el navegador) es lo que hace hoy el código; si cambia, hay que
// cambiar esto y docs/rgpd.md.

function H2({ children }: { children: ReactNode }) {
  return <h2 className="mt-8 text-lg font-semibold">{children}</h2>;
}

function List({ items }: { items: ReactNode[] }) {
  return (
    <ul className="mt-2 list-disc space-y-1 pl-5">
      {items.map((item, i) => (
        <li key={i}>{item}</li>
      ))}
    </ul>
  );
}

function ProcessorsTable() {
  return (
    <div className="mt-3 overflow-x-auto">
      <table className="w-full min-w-[40rem] text-left text-sm" data-testid="legal-processors">
        <thead>
          <tr className="border-b border-border text-muted">
            <th className="py-2 pr-3 font-medium">Proveedor</th>
            <th className="py-2 pr-3 font-medium">Para qué</th>
            <th className="py-2 pr-3 font-medium">Dónde</th>
            <th className="py-2 pr-3 font-medium">Transferencia</th>
            <th className="py-2 font-medium">Estado</th>
          </tr>
        </thead>
        <tbody>
          {PROCESSORS.map((p) => (
            <tr key={p.name} className="border-b border-border align-top">
              <td className="py-2 pr-3 font-medium">{p.name}</td>
              <td className="py-2 pr-3">{p.purpose}</td>
              <td className="py-2 pr-3">{p.region}</td>
              <td className="py-2 pr-3">{p.transfer}</td>
              <td className="py-2">
                <Badge tone={p.status === 'in_use' ? 'primary' : 'neutral'}>{PROCESSOR_STATUS_LABEL[p.status]}</Badge>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Privacy() {
  return (
    <>
      <H2>1. Quién trata tus datos</H2>
      <p>
        {P.company}, con CIF {P.taxId} y domicilio en {P.address} (en adelante, «nosotros»), titular de {APP_NAME}.
        Contacto para todo lo relativo a tus datos: {P.privacyEmail}. {P.dpo}.
      </p>
      <p className="mt-2">Tratamos los datos en dos papeles distintos:</p>
      <List
        items={[
          <>
            <strong>Como responsables</strong>, los datos de tu cuenta: los que necesitamos para darte acceso, mantener
            la seguridad del servicio y cumplir nuestras obligaciones.
          </>,
          <>
            <strong>Como encargados del tratamiento</strong> de cada organización cliente, lo que la organización y su
            equipo suben o crean (marcas, perfiles de marca, contenidos, fotos, vídeos, encargos y comentarios). La
            organización decide para qué usa esos datos y es su responsable; lo regula el contrato de encargo del
            tratamiento que firmamos con ella. {'[CONTRATO DE ENCARGO DEL TRATAMIENTO]'}
          </>,
        ]}
      />

      <H2>2. Qué datos tratamos</H2>
      <List
        items={[
          'Cuenta: nombre, correo electrónico, contraseña (la guarda cifrada el servicio de autenticación; nosotros no la vemos), idioma y fechas de alta y de último acceso.',
          'Pertenencia a organizaciones y marcas, y el rol en cada una.',
          'Actividad: un registro de quién hizo qué (crear, cambiar o borrar elementos) para la seguridad y la trazabilidad del trabajo de la organización.',
          'Lo que escribes o subes en una organización: contenidos y sus versiones, encargos, comentarios, archivos de la biblioteca y perfiles de marca. Pueden incluir datos de otras personas (por ejemplo, fotos de empleados o clientes); la organización debe tener una base legal para usarlos.',
          'Uso de la IA: qué se pidió, con qué proveedor y modelo, y su coste. Si tu organización usa la IA, el texto y las imágenes de la petición se envían al proveedor elegido (apartado 6).',
          'Aceptación de estas condiciones y de esta política: versión y fecha.',
          'Dictado por voz (solo si lo pulsas): el navegador envía el audio a Google (Chrome) o Microsoft (Edge) para convertirlo en texto; nosotros solo recibimos el texto.',
          'Google Drive (solo si tu organización lo conecta): leemos, con permiso de solo lectura, las imágenes de las carpetas elegidas.',
          'Datos técnicos: dirección IP y datos del navegador en los registros de los proveedores de infraestructura; lo que la aplicación guarda en tu navegador está en la política de cookies.',
        ]}
      />

      <H2>3. Para qué y con qué base legal</H2>
      <p className="text-sm text-muted">Propuesta pendiente de revisión jurídica.</p>
      <List
        items={[
          'Darte acceso y prestarte el servicio contratado: ejecución del contrato (art. 6.1.b del RGPD).',
          'Registro de actividad y seguridad del servicio: interés legítimo en proteger las cuentas y en que cada organización sepa quién hizo qué (art. 6.1.f).',
          'Guardar la prueba de que aceptaste las condiciones y conociste esta política: obligación de poder demostrarlo e interés legítimo (art. 6.1.c y 6.1.f).',
          'Facturación, cuando exista: obligación legal (art. 6.1.c). [PENDIENTE: PLANES Y PAGOS]',
          'Generar textos o imágenes con IA a petición de tu organización: ejecución del contrato con la organización, como encargados.',
        ]}
      />
      <p className="mt-2">
        No hay decisiones automatizadas con efectos jurídicos sobre ti. La IA propone textos e imágenes que revisa y
        aprueba una persona. No vendemos tus datos ni los usamos para publicidad.
      </p>

      <H2>4. Cuánto tiempo los guardamos</H2>
      <List
        items={[
          'Mientras tengas la cuenta. Al borrarla, se borran tu cuenta y tu perfil, y tu nombre desaparece de la autoría de lo que hiciste en las organizaciones (que conservan su trabajo). [CONFIRMAR]',
          'Los datos de una organización, mientras exista. Al borrarla se borran sus datos y archivos; solo queda constancia de que se borró. [CONFIRMAR]',
          'Copias de seguridad del proveedor de base de datos: [PLAZO DE LAS COPIAS DE SEGURIDAD].',
          'Registro de actividad: [PLAZO A DECIDIR].',
          'Consumo de IA (sin datos personales) y facturación: [PLAZO LEGAL A CONFIRMAR].',
        ]}
      />

      <H2>5. Tus derechos</H2>
      <p>
        Puedes acceder a tus datos, rectificarlos, pedir que se borren, limitar u oponerte a su tratamiento y
        llevártelos en un formato legible por máquina. Desde la aplicación, en «Mi cuenta»:{' '}
        <strong>Descargar mis datos</strong> (un archivo que se puede abrir y reutilizar) y{' '}
        <strong>Borrar mi cuenta</strong>. Para lo demás, escribe a {P.privacyEmail}. Si los datos son de una
        organización, atenderemos tu petición junto con ella, que es su responsable.
      </p>
      <p className="mt-2">
        Si crees que no hemos atendido bien tu petición, puedes reclamar ante la Agencia Española de Protección de Datos
        (www.aepd.es).
      </p>

      <H2>6. Proveedores (encargados del tratamiento) y transferencias</H2>
      <p>
        Estos son los proveedores que tratan datos por nuestra cuenta. Los de IA solo intervienen si tu organización usa
        la IA y la plataforma los tiene activados; por defecto se usan los que procesan en la Unión Europea, y uno de
        fuera solo con la aceptación expresa de la organización.
      </p>
      <ProcessorsTable />

      <H2>7. Contenido generado con IA</H2>
      <p>
        La aplicación marca las piezas que llevan texto o imágenes generados con IA, para que la organización pueda
        avisarlo al publicar como exigen la normativa y las redes sociales.
      </p>

      <H2>8. Seguridad</H2>
      <p>
        Cada organización solo ve sus datos: el aislamiento lo impone la base de datos, no solo la aplicación. Los
        archivos se guardan en un almacenamiento privado (Supabase o Cloudflare R2, en la UE) y se comparten con enlaces
        que caducan. [MEDIDAS ADICIONALES A DESCRIBIR]
      </p>

      <H2>9. Cambios</H2>
      <p>
        Si cambiamos esta política te lo diremos en la aplicación y, si el cambio lo requiere, te pediremos que la
        vuelvas a aceptar.
      </p>
    </>
  );
}

function Terms() {
  return (
    <>
      <H2>1. Objeto</H2>
      <p>
        Estas condiciones regulan el uso de {APP_NAME}, una plataforma para gestionar las redes sociales de empresas y
        agencias, prestada por {P.company} (CIF {P.taxId}, {P.address}).
      </p>

      <H2>2. Cuenta</H2>
      <List
        items={[
          'Para usar la plataforma necesitas una cuenta personal con un correo que confirmes. Eres responsable de guardar tu contraseña.',
          'Al crearla aceptas estas condiciones y declaras haber leído la política de privacidad.',
          'Puedes borrar tu cuenta cuando quieras desde «Mi cuenta». Si eres la única persona propietaria de una organización con más miembros, antes tendrás que traspasar la propiedad o borrar la organización.',
        ]}
      />

      <H2>3. Organizaciones, marcas y roles</H2>
      <p>
        Una organización (empresa o agencia) agrupa marcas y personas con distintos roles. Quien la crea es su
        propietario y responde de las personas a las que invita y de los permisos que les da. Un propietario puede
        exportar todos los datos de la organización y borrarla.
      </p>

      <H2>4. Uso aceptable</H2>
      <List
        items={[
          'No subas contenido ilícito ni que infrinja derechos de terceros (de autor, de marca, de imagen o de protección de datos).',
          'Necesitas el permiso de las personas que aparecen en las fotos y vídeos que subes, y una base legal para tratar sus datos.',
          'No intentes acceder a datos de otras organizaciones ni eludir los límites del servicio.',
        ]}
      />

      <H2>5. Tu contenido</H2>
      <p>
        El contenido que subes o creas es tuyo o de tu organización. Nos das solo el permiso necesario para guardarlo,
        procesarlo y mostrártelo mientras prestamos el servicio. [REVISAR LA LICENCIA CON EL ABOGADO]
      </p>

      <H2>6. Inteligencia artificial</H2>
      <List
        items={[
          'Los textos e imágenes que propone la IA pueden contener errores: revísalos antes de publicarlos. Las comprobaciones automáticas ayudan a revisar, pero no garantizan el cumplimiento de ninguna norma.',
          'La plataforma marca las piezas que llevan contenido generado con IA. Quien publica es responsable de avisarlo cuando la ley o la red social lo exijan.',
          'Lo generado sin aportación humana puede no estar protegido por derechos de autor. [REVISAR CON EL ABOGADO]',
          'No pidas a la IA imágenes de personas reales ni que se les parezcan.',
        ]}
      />

      <H2>7. Precio</H2>
      <p>[PLANES, PRECIOS, FORMA DE PAGO Y RENOVACIÓN]</p>

      <H2>8. Disponibilidad y responsabilidad</H2>
      <p>
        Trabajamos para que el servicio esté disponible y sea seguro, pero puede tener interrupciones. [LIMITACIÓN DE
        RESPONSABILIDAD A REDACTAR POR EL ABOGADO]
      </p>

      <H2>9. Fin del servicio</H2>
      <p>
        Puedes darte de baja en cualquier momento. Antes de borrar una organización, su propietario puede exportar sus
        datos. [PLAZOS DE PREAVISO Y SUSPENSIÓN POR INCUMPLIMIENTO]
      </p>

      <H2>10. Ley aplicable</H2>
      <p>Ley española. {P.jurisdiction}.</p>
    </>
  );
}

function LegalNotice() {
  return (
    <>
      <H2>Titular</H2>
      <List
        items={[
          `Titular: ${P.company}`,
          `CIF: ${P.taxId}`,
          `Domicilio: ${P.address}`,
          `Inscripción: ${P.registry}`,
          `Contacto: ${P.contactEmail}`,
          `Sitio web: ${P.domain}`,
        ]}
      />
      <H2>Propiedad intelectual</H2>
      <p>
        El software, el diseño y los textos de {APP_NAME} son de {P.company} o de sus licenciantes. El contenido que
        suben las organizaciones es de ellas.
      </p>
      <H2>Responsabilidad</H2>
      <p>[CONDICIONES DE RESPONSABILIDAD SOBRE EL SITIO Y LOS ENLACES A TERCEROS, A REDACTAR POR EL ABOGADO]</p>
      <H2>Protección de datos</H2>
      <p>
        Ver la <Link to={legalPath('privacy')}>política de privacidad</Link>.
      </p>
    </>
  );
}

function Cookies() {
  return (
    <>
      <H2>Resumen</H2>
      <p>
        {APP_NAME} <strong>no usa cookies</strong> ni herramientas de analítica o publicidad. Guarda en el
        almacenamiento local de tu navegador solo lo necesario para funcionar y las preferencias que eliges. Por eso no
        te pedimos consentimiento con un aviso de cookies: estos usos están exentos (art. 22.2 de la LSSI). Si algún día
        añadimos algo que no lo esté, te lo pediremos antes.
      </p>
      <H2>Qué se guarda en tu navegador</H2>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full min-w-[32rem] text-left text-sm" data-testid="legal-storage">
          <thead>
            <tr className="border-b border-border text-muted">
              <th className="py-2 pr-3 font-medium">Clave</th>
              <th className="py-2 pr-3 font-medium">Para qué</th>
              <th className="py-2 font-medium">Cuánto dura</th>
            </tr>
          </thead>
          <tbody>
            {[
              [
                'sb-…-auth-token',
                'Tu sesión (la pone el servicio de autenticación). Imprescindible.',
                'Hasta que cierras sesión',
              ],
              ['rrss.theme', 'El tema que eliges (claro, oscuro o el del sistema).', 'Hasta que lo cambias'],
              [
                'rrss.last.…',
                'La última organización y marca que abriste, para volver a ellas.',
                'Hasta que borras tu cuenta o los datos del navegador',
              ],
              [
                'rrss.brandDraft.…',
                'El borrador del asistente de alta de marca, para no perderlo si cierras la pestaña.',
                'Hasta que terminas o descartas el alta',
              ],
              ['rrss.pendingInvite', 'La invitación que abriste antes de iniciar sesión.', 'Hasta que la aceptas'],
            ].map(([key, purpose, duration]) => (
              <tr key={key} className="border-b border-border align-top">
                <td className="py-2 pr-3 font-mono text-xs">{key}</td>
                <td className="py-2 pr-3">{purpose}</td>
                <td className="py-2">{duration}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-3">
        Puedes borrarlo desde la configuración de tu navegador. Al borrar tu cuenta, la aplicación borra lo suyo de ese
        navegador.
      </p>
      <p className="mt-2 text-sm text-muted">
        Los proveedores de infraestructura (apartado 6 de la política de privacidad) registran datos técnicos de cada
        petición, como la dirección IP, para servir la aplicación y protegerla.
      </p>
    </>
  );
}

const CONTENT: Record<LegalDocumentId, () => ReactNode> = {
  privacy: Privacy,
  terms: Terms,
  'legal-notice': LegalNotice,
  cookies: Cookies,
};

export function LegalPage() {
  const { slug } = useParams();
  const doc = LEGAL_DOCUMENTS.find((d) => d.slug === slug);
  if (!doc) return <Navigate to={legalPath('privacy')} replace />;
  const Content = CONTENT[doc.id];
  const version = doc.id === 'privacy' || doc.id === 'terms' ? LEGAL_VERSIONS[doc.id] : null;

  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6" data-testid={`legal-page-${doc.id}`}>
      <Link to="/" className="inline-flex items-center gap-1 text-sm text-muted hover:text-fg">
        <ChevronLeft className="h-4 w-4" aria-hidden />
        {APP_NAME}
      </Link>
      <h1 className="mt-3 flex items-center gap-2 text-2xl">
        <Scale className="h-6 w-6 text-muted" aria-hidden />
        {doc.title}
      </h1>
      {version && <p className="mt-1 text-sm text-muted">Versión {version}</p>}
      <div className="mt-4" data-testid="legal-draft-warning">
        <Notice tone="warning">
          <strong>Borrador sin validez legal.</strong> Es una plantilla: los datos entre corchetes faltan y un abogado
          debe revisar el texto antes de usarlo con clientes. Esto no es asesoría legal.
        </Notice>
      </div>
      <article className="mt-2 text-sm leading-relaxed [&_a]:text-primary [&_a]:underline">
        <Content />
      </article>
      <LegalFooter className="mt-10" />
    </main>
  );
}
