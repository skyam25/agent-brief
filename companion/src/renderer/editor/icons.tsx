/** Editor icons, drawn like the panel's own in `../Icons`. */

import type { ReactNode } from 'react';
import { Icon } from '../Icons';

export const CodeIcon = () => (
  <Icon>
    <path d="m16 18 6-6-6-6" />
    <path d="m8 6-6 6 6 6" />
  </Icon>
);

/** A table with one band shaded, and an arrow saying where a new one goes. */
const Band = (props: { band: ReactNode; arrow: ReactNode }) => (
  <Icon>
    <rect x="3" y="3" width="18" height="18" rx="2" />
    {props.band}
    {props.arrow}
  </Icon>
);

export const RowAboveIcon = () => <Band band={<path d="M3 9h18" />} arrow={<path d="M12 13v5M9.5 15.5 12 13l2.5 2.5" />} />;
export const RowBelowIcon = () => <Band band={<path d="M3 15h18" />} arrow={<path d="M12 6v5M9.5 8.5 12 11l2.5-2.5" />} />;
export const ColLeftIcon = () => <Band band={<path d="M9 3v18" />} arrow={<path d="M13 12h5M15.5 9.5 13 12l2.5 2.5" />} />;
export const ColRightIcon = () => <Band band={<path d="M15 3v18" />} arrow={<path d="M6 12h5M8.5 9.5 11 12l-2.5 2.5" />} />;

export const HeaderRowIcon = () => (
  <Icon>
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <path d="M3 9h18" />
    <path d="M3 3h18v6H3z" fill="currentColor" opacity="0.25" stroke="none" />
  </Icon>
);
