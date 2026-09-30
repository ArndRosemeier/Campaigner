import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), loading: vi.fn() },
}));

import { toast } from 'sonner';
import { toastError, toastErrorPersistent } from '@/lib/toast';
import { ZOD_SKEW_MITIGATION } from '@/lib/zodErrorSummary';

/**
 * Toast-seam pins (error-humanization arc): the leading `message` title is
 * untouched and plain-Error descriptions pass through byte-identical (no
 * regression for existing callers); ZodError-shaped failures are humanized
 * in the description only, with the full raw error one click away in the
 * console — never megabytes in the toast.
 *
 * The `toastError*` pins double as the TRANSIENT-vs-PERSISTENT contract
 * (docs/17 row 136): the option objects are asserted exactly, so
 * `toastErrorPersistent` carrying `closeButton: true` and a transient
 * `toastError` carrying none are both visible here — a closer appearing on the
 * 4-second toasts (a global `closeButton` on the `Toaster`) would fail these.
 */

const toastErrorMock = vi.mocked(toast.error);

afterEach(() => {
  vi.clearAllMocks();
});

describe('toastError', () => {
  it('passes plain-Error descriptions through byte-identical (no regression)', () => {
    const error = new Error('Not a Campaigner zip export (manifest missing)');
    toastError('Import failed — is this a Campaigner export?', error);
    expect(toastErrorMock).toHaveBeenCalledWith('Import failed — is this a Campaigner export?', {
      description: 'Not a Campaigner zip export (manifest missing)',
    });
  });

  it('shows a bare title when there is no Error', () => {
    toastError('Import failed — is this a Campaigner export?');
    expect(toastErrorMock).toHaveBeenCalledWith('Import failed — is this a Campaigner export?');
  });

  it('humanizes ZodErrors: title untouched, description grouped + mitigating, never raw JSON', () => {
    const parsed = z
      .object({
        artifacts: z.array(z.object({ name: z.string() })),
        battles: z.array(z.object({ id: z.string() })),
      })
      .safeParse({ artifacts: [{}, {}, {}, {}], battles: [{}] });
    if (parsed.success) throw new Error('fixture should fail validation');
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    toastError('Import failed — is this a Campaigner export?', parsed.error);

    expect(toastErrorMock).toHaveBeenCalledTimes(1);
    const [title, options] = toastErrorMock.mock.calls[0] as [
      string,
      { description?: string },
    ];
    expect(title).toBe('Import failed — is this a Campaigner export?');
    const description = options.description ?? '';
    expect(description).toContain('problems in this file');
    expect(description).toContain(ZOD_SKEW_MITIGATION);
    expect(description).not.toContain('"code"');
    expect(description).not.toContain('invalid_type');
    // The full raw error stays one click away in devtools.
    expect(consoleSpy).toHaveBeenCalledWith(parsed.error);
    consoleSpy.mockRestore();
  });

  it('humanizes ZodError-shaped aggregates without instanceof', () => {
    const shaped = Object.assign(new Error('aggregate'), {
      issues: [{ path: ['artifacts', 0], message: 'Invalid input' }],
    });
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    toastError('Import failed', shaped);
    const [, options] = toastErrorMock.mock.calls[0] as [string, { description?: string }];
    expect(options.description).toContain('artifacts[0]');
    expect(options.description).not.toContain('aggregate');
    consoleSpy.mockRestore();
  });
});

describe('toastErrorPersistent', () => {
  it('routes ZodErrors through the same humanizer, staying dismissible-only-by-user', () => {
    const parsed = z.object({ name: z.string() }).safeParse({});
    if (parsed.success) throw new Error('fixture should fail validation');
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    toastErrorPersistent('Unexpected error', parsed.error);

    const [title, options] = toastErrorMock.mock.calls[0] as [
      string,
      { duration?: number; description?: string; closeButton?: boolean },
    ];
    expect(title).toBe('Unexpected error');
    expect(options.duration).toBe(Infinity);
    // No auto-dismiss means the notice MUST carry sonner's close control, or
    // "persistent" is "permanent" (docs/17 row 136 — the owner clicked the
    // error ICON believing it was a closer). Asserted here at the seam so the
    // flag cannot be dropped from one branch only.
    expect(options.closeButton).toBe(true);
    expect(options.description).toContain(ZOD_SKEW_MITIGATION);
    expect(consoleSpy).toHaveBeenCalledWith(parsed.error);
    consoleSpy.mockRestore();
  });

  it('keeps plain-Error descriptions byte-identical', () => {
    const error = new Error('background task blew up');
    toastErrorPersistent('Unhandled error in a background task', error);
    // The ONLY option this slice added is `closeButton`; the title and the
    // description are byte-identical to before.
    expect(toastErrorMock).toHaveBeenCalledWith('Unhandled error in a background task', {
      duration: Infinity,
      description: 'background task blew up',
      closeButton: true,
    });
  });
});
