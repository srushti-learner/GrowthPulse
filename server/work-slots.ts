let active = 0;

// Foreground scans and the local worker share the existing two-operation budget.
export function claimWorkSlot() {
  if (active >= 2) return null;
  active++;
  let released = false;
  return () => {
    if (!released) { released = true; active--; }
  };
}
