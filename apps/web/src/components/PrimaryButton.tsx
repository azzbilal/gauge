import { forwardRef } from 'react';
import type { ButtonHTMLAttributes } from 'react';

type Props = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> & { label: string };

/**
 * The one main action of a view: a bright stroke, no fill. The label is rendered
 * twice so the copy can slide up into place on hover; the copy is hidden from
 * assistive tech.
 */
export const PrimaryButton = forwardRef<HTMLButtonElement, Props>(function PrimaryButton(
  { label, className, ...rest },
  ref,
) {
  return (
    <button ref={ref} className={`primary${className ? ` ${className}` : ''}`} {...rest}>
      <span className="primary-label">
        <span>{label}</span>
        <span aria-hidden="true">{label}</span>
      </span>
    </button>
  );
});
