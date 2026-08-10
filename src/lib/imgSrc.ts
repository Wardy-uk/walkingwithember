export function imgSrc(path: string): string {
  if (!path) return path;
  return path.replace(/\.(heif|heic)$/i, '.jpg');
}
