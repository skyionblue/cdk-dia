import * as fs from 'fs'
import {CdkDiaTheme} from './theme'

const LOGO_HEIGHT = 60
const LOGO_MARGIN = 24
const FOOTER_BAR_HEIGHT = 48
const FOOTER_FONT_SIZE = 22
const TITLE_FONT_SIZE = 28

export class PostProcessor {

    static async apply(pngPath: string, theme: CdkDiaTheme): Promise<void> {
        if (!theme.logoPath && !theme.title && !theme.footer && !theme.companyName) {
            return
        }

        // dynamic import so sharp is only loaded when branding is active
        const sharp = (await import('sharp')).default

        let image = sharp(pngPath)
        const meta = await image.metadata()
        const width = meta.width ?? 800
        const height = meta.height ?? 600

        const needsFooter = !!(theme.footer || theme.companyName)
        const extendedHeight = needsFooter ? height + FOOTER_BAR_HEIGHT : height

        if (needsFooter) {
            image = sharp(await image.extend({ bottom: FOOTER_BAR_HEIGHT, background: { r: 255, g: 255, b: 255, alpha: 1 } }).toBuffer())
        }

        const overlays: import('sharp').OverlayOptions[] = []

        // Logo
        if (theme.logoPath && fs.existsSync(theme.logoPath)) {
            const logoBuffer = await sharp(theme.logoPath)
                .resize({ height: LOGO_HEIGHT, fit: 'inside', withoutEnlargement: true })
                .toBuffer()

            const logoPng = sharp(logoBuffer)
            const logoMeta = await logoPng.metadata()
            const logoWidth = logoMeta.width ?? LOGO_HEIGHT * 3

            const pos = theme.logoPosition ?? 'top-left'
            const top = pos.includes('bottom') ? extendedHeight - LOGO_HEIGHT - LOGO_MARGIN : LOGO_MARGIN
            const left = pos.includes('right') ? width - logoWidth - LOGO_MARGIN : LOGO_MARGIN

            overlays.push({ input: logoBuffer, top, left })
        }

        // Title
        if (theme.title) {
            const titleSvg = PostProcessor.makeSvgText(theme.title, width, TITLE_FONT_SIZE, '#333333', theme.fontName ?? 'Sans-Serif', 'top')
            overlays.push({ input: Buffer.from(titleSvg), top: LOGO_MARGIN, left: 0 })
        }

        // Footer
        if (needsFooter) {
            const footerText = theme.footer ?? theme.companyName ?? ''
            const footerSvg = PostProcessor.makeSvgText(footerText, width, FOOTER_FONT_SIZE, '#888888', theme.fontName ?? 'Sans-Serif', 'middle')
            overlays.push({ input: Buffer.from(footerSvg), top: height + Math.floor((FOOTER_BAR_HEIGHT - FOOTER_FONT_SIZE) / 2), left: 0 })
        }

        if (overlays.length > 0) {
            const result = await image.composite(overlays).png().toBuffer()
            fs.writeFileSync(pngPath, result)
        }
    }

    private static makeSvgText(text: string, width: number, fontSize: number, color: string, fontFamily: string, baseline: 'top' | 'middle'): string {
        const dy = baseline === 'top' ? fontSize : Math.floor(fontSize * 0.35)
        return `<svg width="${width}" height="${fontSize + dy}" xmlns="http://www.w3.org/2000/svg">
  <text x="${width / 2}" y="${fontSize}" text-anchor="middle" font-size="${fontSize}" font-family="${fontFamily}" fill="${color}">${PostProcessor.escapeXml(text)}</text>
</svg>`
    }

    private static escapeXml(s: string): string {
        return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
    }
}
