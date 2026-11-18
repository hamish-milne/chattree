/** The few icons the views use, as 16 px outlines in the current text colour. */
import type { JSX } from "preact";

const PATHS = {
  fork: (
    <>
      <circle cx="4" cy="3.2" r="1.6" />
      <circle cx="4" cy="12.8" r="1.6" />
      <circle cx="12" cy="6" r="1.6" />
      <path d="M4 4.8v6.4M12 7.6c0 2.6-8 1.6-8 3.6" />
    </>
  ),
  rewind: <path d="M3 8a5 5 0 1 0 1.7-3.8M3 2.2v3.2h3.2" />,
  copy: (
    <>
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.2" />
      <path d="M10.5 5.5v-2a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2" />
    </>
  ),
  attach: <path d="M10.6 4.4 5.4 9.6a1.5 1.5 0 0 0 2.1 2.1l5.2-5.2a3 3 0 0 0-4.2-4.2L3.2 7.5a4.4 4.4 0 0 0 6.3 6.3l3.8-3.8" />,
  send: <path d="M8 13V3.2M3.5 7.5 8 3l4.5 4.5" />,
  stop: <rect x="4" y="4" width="8" height="8" rx="1" />,
  chevron: <path d="m6 3.5 4.5 4.5L6 12.5" />,
  repo: (
    <>
      <path d="M3 13V3.5A1.5 1.5 0 0 1 4.5 2H13v10H4.5A1.5 1.5 0 0 0 3 13.5 1.5 1.5 0 0 0 4.5 15H13" />
    </>
  ),
  check: <path d="m3 8.5 3.2 3L13 4.5" />,
  x: <path d="m3.5 3.5 9 9m0-9-9 9" />,
  ban: (
    <>
      <circle cx="8" cy="8" r="5.5" />
      <path d="m4.1 4.1 7.8 7.8" />
    </>
  ),
  clock: (
    <>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M8 4.8V8l2 1.5" />
    </>
  ),
  sliders: <path d="M2.5 4.5h6m3 0h2M2.5 11.5h2m3 0h6M8.5 3v3m-4 5v3" />,
  down: <path d="M8 3v9.5M3.5 8.5 8 13l4.5-4.5" />,
  info: (
    <>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M8 7.2v3.6M8 5v.1" />
    </>
  ),
  file: <path d="M4 1.8h5l3 3v9.4H4zM9 1.8v3h3" />,
  image: (
    <>
      <rect x="2.5" y="3" width="11" height="10" rx="1.2" />
      <circle cx="6" cy="6.5" r="1" />
      <path d="m3 12 3.5-3.5 2.5 2.5 1.5-1.5 3 3" />
    </>
  ),
  plus: <path d="M8 3v10M3 8h10" />,
  trash: <path d="M3 4.5h10M6 4.5V3h4v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5" />,
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 14 }: { name: IconName; size?: number }): JSX.Element {
  return (
    <svg
      class="icon"
      viewBox="0 0 16 16"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      stroke-width="1.4"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      {PATHS[name]}
    </svg>
  );
}
