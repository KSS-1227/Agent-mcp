import type { Metadata, Viewport } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";

/**
 * Fonts are fetched at build time and served from our own origin, so the page
 * makes no third-party request at runtime and renders identically offline.
 *
 * `display: swap` because a fallback in the right size beats invisible text:
 * the page's whole argument is legible before the webfont lands.
 */
const inter = Inter({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-inter",
});

const mono = JetBrains_Mono({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-jetbrains",
});

export const metadata: Metadata = {
  title: "INTERLOCK — memory that lets parallel agents think without corrupting each other",
  description:
    "An LLM agent reads shared memory, thinks for 40 seconds, then acts. The world changed while it was thinking. INTERLOCK is agent memory built on CockroachDB that detects semantic conflicts, repairs only the dependent steps, and commits serializably.",
  keywords: [
    "agent memory",
    "multi-agent",
    "concurrency control",
    "CockroachDB",
    "serializable",
    "AS OF SYSTEM TIME",
    "vector index",
    "AWS Bedrock",
  ],
  openGraph: {
    title: "INTERLOCK",
    description:
      "Running AI agents in parallel today is slower than running them one at a time, and costs 83% more. INTERLOCK fixes that.",
    type: "website",
  },
};

export const viewport: Viewport = {
  // Light is the site's default, so it is also the default browser chrome
  // colour. The dark entry only applies once someone has actually chosen dark.
  themeColor: "#f6f5f1",
};

/**
 * Runs before first paint so the correct theme is applied with no flash.
 * Precedence: explicit user choice (localStorage) > OS preference.
 */
const noFlashTheme = `
(function () {
  try {
    // ?theme=light|dark pins the theme for this visit and sticks. Lets a
    // specific look be linked to directly — for a screenshot, a walkthrough,
    // or a reader on a machine whose OS setting is not the one being discussed.
    var q = null;
    try {
      q = new URLSearchParams(window.location.search).get('theme');
    } catch (e) {}
    if (q !== 'light' && q !== 'dark') q = null;
    if (q) localStorage.setItem('interlock-theme', q);

    // Light is the default for a first-time visitor, regardless of their OS
    // setting. A deliberate product choice: this page is read by people
    // evaluating it once, often on a projector or an embedded video, and the
    // light theme survives both better. An explicit choice still wins, and
    // still persists — we override the OS default, never the person.
    var theme = q || localStorage.getItem('interlock-theme') || 'light';
    document.documentElement.setAttribute('data-theme', theme);
  } catch (e) {
    document.documentElement.setAttribute('data-theme', 'light');
  }
})();
`;

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`h-full ${inter.variable} ${mono.variable}`}
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: noFlashTheme }} />
      </head>
      <body className="min-h-full flex flex-col bg-page text-ink">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:m-3 focus:rounded-md focus:bg-surface focus:px-4 focus:py-2 focus:ring-1 focus:ring-hairline-strong"
        >
          Skip to content
        </a>
        {children}
      </body>
    </html>
  );
}
