"use client";

import { useEffect, useState } from "react";

type Theme = "light" | "dark";

/**
 * Toggles between light and dark and persists the choice.
 *
 * The initial attribute is set by an inline script in the root layout before
 * first paint, so there is no flash. This component only reads what that
 * script decided and lets the reader override it.
 */
export default function ThemeToggle() {
  const [theme, setTheme] = useState<Theme | null>(null);

  useEffect(() => {
    const current = document.documentElement.getAttribute("data-theme");
    setTheme(current === "dark" ? "dark" : "light");
  }, []);

  const toggle = () => {
    const next: Theme = theme === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    try {
      localStorage.setItem("interlock-theme", next);
    } catch {
      /* private mode — the in-page toggle still works, it just won't persist */
    }
    setTheme(next);
  };

  // Render a same-size placeholder until mounted so the header doesn't shift.
  if (theme === null) {
    return <span className="h-9 w-9" aria-hidden="true" />;
  }

  const goingDark = theme === "light";

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={goingDark ? "Switch to dark theme" : "Switch to light theme"}
      title={goingDark ? "Switch to dark theme" : "Switch to light theme"}
      className="inline-flex h-9 w-9 cursor-pointer items-center justify-center rounded-md border border-hairline text-ink-2 transition-colors hover:border-hairline-strong hover:text-ink"
    >
      {goingDark ? (
        // Moon
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
        </svg>
      ) : (
        // Sun
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
        </svg>
      )}
    </button>
  );
}
