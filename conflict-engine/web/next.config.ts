import type { NextConfig } from "next";

/**
 * Static export.
 *
 * The whole site prerenders — there is no server-side data fetching on the
 * marketing page — so exporting to plain files lets it sit behind S3 and
 * CloudFront with nothing to keep running, nothing to patch, and nothing to
 * fall over during the judging window.
 *
 * That matters here: the rules require the demo to stay reachable, free and
 * unrestricted from submission until judging closes several weeks later. A
 * static bundle on CloudFront is the deployment shape least likely to be
 * quietly broken by then.
 */
const nextConfig: NextConfig = {
  output: "export",

  // S3 static hosting resolves directories to index.html, so emit /page/index.html
  // rather than /page.html and let the bucket's document-root rule do the work.
  trailingSlash: true,

  images: {
    // No image optimisation server exists in an export; nothing on this page
    // needs it, and being explicit avoids a confusing build-time failure.
    unoptimized: true,
  },
};

export default nextConfig;
