import type { ReactNode } from 'react';

/**
 * THE labeled form-field wrapper (docs/17 row 315): one `<label>` with the
 * shared `text-xs font-medium` caption above its control. The artifact kind
 * forms (`kind-forms.tsx`) and the stat-block editor (`stat-block.tsx`) each
 * carried a byte-identical private copy until the duplicate-body tripwire
 * (`tests/architecture/duplicateImplementationsBaseline.json`, group
 * `12c29e97676c2c29`) named them; both now import THIS one export — no second
 * definition and no re-export shim.
 */
export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
      {label}
      {children}
    </label>
  );
}
