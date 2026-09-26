/**
 * Resolves an image path for use in a src attribute.
 *
 * Local uploads are stored as both .heif and .jpg; browsers want the .jpg.
 *
 * Cloudinary-hosted images are rewritten to request an optimised rendition.
 * Without this the site serves the untouched original — the homepage masthead
 * alone is 7.5MB, where `f_auto,q_auto,w_1600` delivers the same picture in
 * about 650KB and hands AVIF/WebP to browsers that accept them.
 *
 * @param path  A local path or absolute URL.
 * @param width Target width in pixels. Defaults to 1600, which covers a
 *              full-bleed hero on a 2x laptop display; pass something smaller
 *              for cards and thumbnails.
 */
export function imgSrc(path: string, width = 1600): string {
  if (!path) return path;

  // Cloudinary delivery URLs look like:
  //   https://res.cloudinary.com/<cloud>/image/upload/<version>/<public-id>
  // Transformations go in their own segment straight after /upload/.
  const CLOUDINARY_UPLOAD = "/image/upload/";
  if (path.includes("res.cloudinary.com") && path.includes(CLOUDINARY_UPLOAD)) {
    const [base, rest] = path.split(CLOUDINARY_UPLOAD);
    // Leave URLs that already carry a transformation alone, so an explicit
    // choice made elsewhere is never silently overridden.
    if (/^[a-z]_[^/]+\//.test(rest)) return path;
    return `${base}${CLOUDINARY_UPLOAD}f_auto,q_auto,w_${width}/${rest}`;
  }

  return path.replace(/\.(heif|heic)$/i, ".jpg");
}
