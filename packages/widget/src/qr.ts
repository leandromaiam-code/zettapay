import qrcode from 'qrcode-generator';

export interface QrOptions {
  /** Pixel size of the rendered SVG (square). Default 256. */
  size?: number;
  /** Foreground color. Default '#0A0A0A' (deep). */
  dark?: string;
  /** Background color. Default '#FFFFFF'. */
  light?: string;
  /** Error correction level. Higher tolerates more obstruction (e.g. logo). */
  level?: 'L' | 'M' | 'Q' | 'H';
}

/**
 * Returns an inline SVG string for the QR code. We emit SVG instead of
 * canvas/png because (1) it scales crisply at any DPI, (2) it doesn't
 * require a Canvas2D context — relevant when the widget is rendered inside
 * a sandboxed iframe with `allow-scripts` only, and (3) it's tiny on the wire.
 */
export function renderQrSvg(payload: string, options: QrOptions = {}): string {
  const size = options.size ?? 256;
  const dark = options.dark ?? '#0A0A0A';
  const light = options.light ?? '#FFFFFF';
  const level = options.level ?? 'M';

  // Type number `0` lets the library pick the smallest version that fits.
  const qr = qrcode(0, level);
  qr.addData(payload);
  qr.make();

  const moduleCount = qr.getModuleCount();
  const cell = size / moduleCount;

  const cells: string[] = [];
  for (let row = 0; row < moduleCount; row++) {
    for (let col = 0; col < moduleCount; col++) {
      if (qr.isDark(row, col)) {
        const x = (col * cell).toFixed(2);
        const y = (row * cell).toFixed(2);
        const w = cell.toFixed(2);
        cells.push(`<rect x="${x}" y="${y}" width="${w}" height="${w}"/>`);
      }
    }
  }

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" shape-rendering="crispEdges" role="img" aria-label="Payment QR code">`,
    `<rect width="${size}" height="${size}" fill="${light}"/>`,
    `<g fill="${dark}">${cells.join('')}</g>`,
    '</svg>',
  ].join('');
}
