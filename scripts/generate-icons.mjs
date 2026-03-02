// Generate PNG icons from icon-source.svg
// Run: node scripts/generate-icons.js

import sharp from 'sharp'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dir = dirname(fileURLToPath(import.meta.url))
const root  = join(__dir, '..')
const src   = readFileSync(join(root, 'assets/icons/icon-source.svg'))

const sizes = [16, 32, 48, 64, 96, 128, 256]

for (const size of sizes) {
  const out = join(root, `assets/icons/icon-${size}.png`)
  await sharp(src)
    .resize(size, size)
    .png()
    .toFile(out)
  console.log(`✓  ${size}x${size} → ${out}`)
}

console.log('\nDone. Update manifest.json icon paths as needed.')
