// Turns a masthead master into the WebP files the homepage hero serves.
//
//   node scripts/make-hero.mjs <master image> <name>
//
// Writes public/uploads/images/homepage/<name>-<width>.webp at the master's
// own width and at each smaller width below. The homepage reads the width out
// of the file name and finds the smaller siblings itself, so dropping in a
// bigger master is: run this, then point mastheadImage at the new file.
import sharp from "sharp";
import path from "node:path";

const [master, name] = process.argv.slice(2);
if (!master || !name) {
  console.error("usage: node scripts/make-hero.mjs <master image> <name>");
  process.exit(1);
}

const OUT = "public/uploads/images/homepage";
const WIDTHS = [800, 1280, 1920];
const { width } = await sharp(master).metadata();

for (const w of [...WIDTHS.filter((w) => w < width), width]) {
  const file = path.join(OUT, `${name}-${w}.webp`);
  await sharp(master).resize({ width: w }).webp({ quality: 80 }).toFile(file);
  console.log(file);
}
