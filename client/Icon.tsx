const paths = {
  pulse: "M2 12h5l3-7 4 14 3-7h5",
  overview: "M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z",
  globe: "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0 M3 12h18 M12 3c5 5 5 13 0 18 M12 3c-5 5-5 13 0 18",
  box: "m12 3 9 5-9 5-9-5 9-5 M3 8v9l9 5 9-5V8 M12 13v9 M7.5 5.5l9 5",
  chat: "M21 11.5a8.5 8.5 0 0 1-8.5 8.5H4l-2 2V11.5a9.5 9.5 0 0 1 19 0 M7 9h9 M7 13h6",
  spark: "m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3",
  chart: "M4 3v17h17 M8 15l4-5 4 2 5-7",
  sliders: "M4 7h8 M17 7h3 M4 17h3 M12 17h8 M12 4v6 M7 14v6",
  history: "M3 5v5h5 M3 10a9 9 0 1 1 1 8 M12 7v5l3 2",
  arrow: "M5 12h14 M13 6l6 6-6 6",
  diagonal: "M6 18 18 6 M6 6h12v12",
  shield: "m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3 M8 12l3 3 5-6",
  code: "m8 7-5 5 5 5 M16 7l5 5-5 5 M14 4l-4 16",
  plus: "M12 5v14 M5 12h14",
  check: "m5 12 4 4L19 6",
} as const;

export type IconName = keyof typeof paths;

export function Icon({ name, className }: { name: IconName; className?: string }) {
  return (
    <svg className={className} width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={paths[name]} />
    </svg>
  );
}
