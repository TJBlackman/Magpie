import { useId, type ReactNode } from 'react';

interface IconProps {
  size?: number;
  className?: string;
}

function Icon({ size = 16, className, children }: IconProps & { children: ReactNode }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      {children}
    </svg>
  );
}

export const IconDownload = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 3v12" />
    <path d="m7 10 5 5 5-5" />
    <path d="M5 21h14" />
  </Icon>
);

export const IconImages = (p: IconProps) => (
  <Icon {...p}>
    <rect x="3" y="5" width="15" height="13" rx="2" />
    <path d="M21 8v9a3 3 0 0 1-3 3H7" />
    <circle cx="8" cy="10" r="1.5" />
    <path d="m3 16 4-4 3 3 3-3 5 5" />
  </Icon>
);

export const IconSettings = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3h0a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8v0a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
  </Icon>
);

export const IconX = (p: IconProps) => (
  <Icon {...p}>
    <path d="M18 6 6 18" />
    <path d="m6 6 12 12" />
  </Icon>
);

export const IconBack = (p: IconProps) => (
  <Icon {...p}>
    <path d="m15 18-6-6 6-6" />
  </Icon>
);

export const IconSearch = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="11" cy="11" r="8" />
    <path d="m21 21-4.3-4.3" />
  </Icon>
);

export const IconTrash = (p: IconProps) => (
  <Icon {...p}>
    <path d="M3 6h18" />
    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
    <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
  </Icon>
);

export const IconStop = (p: IconProps) => (
  <Icon {...p}>
    <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none" />
  </Icon>
);

export const IconRadio = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="2" fill="currentColor" />
    <path d="M16.2 7.8a6 6 0 0 1 0 8.4" />
    <path d="M7.8 16.2a6 6 0 0 1 0-8.4" />
    <path d="M19.1 4.9a10 10 0 0 1 0 14.2" />
    <path d="M4.9 19.1a10 10 0 0 1 0-14.2" />
  </Icon>
);

export const IconFilm = (p: IconProps) => (
  <Icon {...p}>
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <path d="M7 3v18" />
    <path d="M17 3v18" />
    <path d="M3 12h18" />
    <path d="M3 7.5h4" />
    <path d="M3 16.5h4" />
    <path d="M17 7.5h4" />
    <path d="M17 16.5h4" />
  </Icon>
);

export const IconPlay = (p: IconProps) => (
  <Icon {...p}>
    <path d="M6 4v16l14-8z" fill="currentColor" stroke="none" />
  </Icon>
);

export const IconHistory = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="10" />
    <path d="M12 6v6l4 2" />
  </Icon>
);

export const IconMinus = (p: IconProps) => (
  <Icon {...p}>
    <path d="M5 12h14" />
  </Icon>
);

export const IconPlus = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 5v14" />
    <path d="M5 12h14" />
  </Icon>
);

export const IconCheck = (p: IconProps) => (
  <Icon {...p}>
    <path d="M20 6 9 17l-5-5" />
  </Icon>
);

export const IconUpdate = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="m8 12 4-4 4 4" />
    <path d="M12 16V8" />
  </Icon>
);

export const IconChevron = (p: IconProps) => (
  <Icon {...p}>
    <path d="m9 18 6-6-6-6" />
  </Icon>
);

export const IconInfo = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 11v5" />
    <path d="M12 8h.01" />
  </Icon>
);

export const IconAlert = (p: IconProps) => (
  <Icon {...p}>
    <path d="M10.3 3.9 2.4 17.6A2 2 0 0 0 4.1 20.6h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
    <path d="M12 9.5v4" />
    <path d="M12 17h.01" />
  </Icon>
);

export const IconError = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7.5v5.5" />
    <path d="M12 16.5h.01" />
  </Icon>
);

/** Download again: a circular arrow. */
export const IconRedo = (p: IconProps) => (
  <Icon {...p}>
    <path d="M20 12a8 8 0 1 1-2.3-5.7" />
    <path d="M20 4v5h-5" />
  </Icon>
);

export const IconClock = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 2" />
  </Icon>
);

export const IconImage = (p: IconProps) => (
  <Icon {...p}>
    <rect x="3" y="4" width="18" height="16" rx="2.5" />
    <circle cx="9" cy="10" r="1.6" />
    <path d="m21 16-4.5-4.5L7 20" />
  </Icon>
);

export const IconVideo = (p: IconProps) => (
  <Icon {...p}>
    <rect x="2.5" y="5" width="14" height="14" rx="2.5" />
    <path d="m16.5 10 5-3v10l-5-3" />
  </Icon>
);

export const IconLock = (p: IconProps) => (
  <Icon {...p}>
    <rect x="4.5" y="10.5" width="15" height="10" rx="2.5" />
    <path d="M8 10.5V7.5a4 4 0 0 1 8 0v3" />
  </Icon>
);

export const IconFolder = (p: IconProps) => (
  <Icon {...p}>
    <path d="M3 7.5A2.5 2.5 0 0 1 5.5 5h3.6l2 2.2h7.4A2.5 2.5 0 0 1 21 9.7v7.8a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z" />
  </Icon>
);

export const IconFile = (p: IconProps) => (
  <Icon {...p}>
    <path d="M14 3H7.5A2.5 2.5 0 0 0 5 5.5v13A2.5 2.5 0 0 0 7.5 21h9a2.5 2.5 0 0 0 2.5-2.5V8z" />
    <path d="M14 3v5h5" />
  </Icon>
);

export const IconExternal = (p: IconProps) => (
  <Icon {...p}>
    <path d="M14 4h6v6" />
    <path d="M20 4 11 13" />
    <path d="M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4" />
  </Icon>
);

export const IconEye = (p: IconProps) => (
  <Icon {...p}>
    <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" />
    <circle cx="12" cy="12" r="3" />
  </Icon>
);

export const IconEyeOff = (p: IconProps) => (
  <Icon {...p}>
    <path d="M10.6 5.6A9.7 9.7 0 0 1 12 5.5C18 5.5 21.5 12 21.5 12a17 17 0 0 1-3 3.8" />
    <path d="M6.6 6.6A16.7 16.7 0 0 0 2.5 12S6 18.5 12 18.5a9.4 9.4 0 0 0 5.4-1.7" />
    <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
    <path d="m3 3 18 18" />
  </Icon>
);

export const IconSliders = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4 7h10" />
    <path d="M18 7h2" />
    <circle cx="16" cy="7" r="2" />
    <path d="M4 17h2" />
    <path d="M10 17h10" />
    <circle cx="8" cy="17" r="2" />
  </Icon>
);

export const IconCheckCircle = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="m8.5 12.5 2.5 2.5 4.5-5" />
  </Icon>
);

export const IconMinusCircle = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M8 12h8" />
  </Icon>
);

export const IconMore = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="5.5" cy="12" r="1.3" fill="currentColor" stroke="none" />
    <circle cx="12" cy="12" r="1.3" fill="currentColor" stroke="none" />
    <circle cx="18.5" cy="12" r="1.3" fill="currentColor" stroke="none" />
  </Icon>
);

/**
 * The magpie mark: a Eurasian magpie perched in profile. Black head, bib and back
 * with a stout corvid bill, a white belly and white scapular stripe, a blue sheen
 * wing, and a long graduated tail in the teal to blue sheen. The black reads as a
 * darker shape on the graphite tile; the whites, the eye and the sheen carry the
 * silhouette.
 */
export const Logo = ({ size = 22 }: { size?: number }) => {
  const id = useId();
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" aria-hidden="true">
      <defs>
        <linearGradient id={`${id}t`} x1="13" y1="15" x2="1" y2="22.5" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#1fd8cf" />
          <stop offset="1" stopColor="#3d8fe0" />
        </linearGradient>
        <linearGradient id={`${id}w`} x1="18" y1="8.5" x2="9.5" y2="16" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#4a9ae6" />
          <stop offset="1" stopColor="#3d8fe0" />
        </linearGradient>
        <linearGradient id={`${id}p`} x1="0" y1="8" x2="0" y2="16.5" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#f6f8f9" />
          <stop offset="1" stopColor="#d4dbe0" />
        </linearGradient>
      </defs>
      {/* head, bib, back and vent */}
      <path d="M19.9 4.6C21.1 4.85 22.5 5.6 23.4 6.55C22.3 6.75 21.3 7.1 20.5 7.5C21 8.8 21 10.4 20.3 11.8C19.3 13.8 17.2 15.4 14.6 16.15C13.5 16.45 12.8 16.4 12.4 16.1L11.6 14.8C12.8 12.5 13.8 10.1 15 7.9C15 5.7 16.2 3.8 18 3.6C18.8 3.6 19.5 4 19.9 4.6Z" fill="#08090a" />
      {/* graduated tail */}
      <path d="M13.04 14.5L4.28 19.32C2.41 20.49 1.15 21.89 .86 22.58C1.61 22.66 3.44 22.21 5.35 21.13L13.76 15.7Z" fill={`url(#${id}t)`} />
      {/* white belly */}
      <path d="M20.55 11.2C19.6 13.5 17.4 15.3 14.7 16.1C14.1 16.3 13.6 16.4 13.1 16.4C12.9 15.5 13.2 14.6 13.8 14C15.6 12.4 17.9 11.1 20.55 11.2Z" fill={`url(#${id}p)`} />
      {/* folded wing */}
      <path d="M18 8.4C19 9.5 18.9 11.4 17.6 12.7C15.8 14.5 12.4 15.5 9.4 16C12 13.1 15.6 9.5 18 8.4Z" fill={`url(#${id}w)`} />
      {/* white scapular stripe */}
      <path d="M17.7 7.9C18.7 8.8 18.3 10.2 16.9 11.2C15.6 12.1 13.9 12.8 12.2 13.3C13.6 11.5 15.1 9.9 16.3 8.7C16.7 8.3 17.2 7.9 17.7 7.9Z" fill={`url(#${id}p)`} />
      <circle cx="18.5" cy="5.7" r=".6" fill="#cfd4d8" />
    </svg>
  );
};
