import { Link } from 'react-router-dom';
import { cn } from '@/lib/utils';
import { LEGAL_DOCUMENTS, legalPath } from './legal';

/** Enlaces a las páginas legales: pie del registro, de la aplicación y de la cuenta. */
export function LegalFooter({ className }: { className?: string }) {
  return (
    <nav aria-label="Información legal" className={cn('text-xs text-muted', className)} data-testid="legal-footer">
      <ul className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1">
        {LEGAL_DOCUMENTS.map((doc) => (
          <li key={doc.id}>
            <Link to={legalPath(doc.id)} className="hover:text-fg hover:underline">
              {doc.title}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
