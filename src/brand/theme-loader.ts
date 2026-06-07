import * as fs from 'fs'
import * as path from 'path'
import {CdkDiaTheme, DEFAULT_THEME} from './theme'

export function loadTheme(themePath: string): CdkDiaTheme {
    const resolved = path.isAbsolute(themePath) ? themePath : path.join(process.cwd(), themePath)
    const raw = fs.readFileSync(resolved, 'utf-8')
    const parsed: CdkDiaTheme = JSON.parse(raw)
    const themeDir = path.dirname(resolved)

    if (parsed.logoPath && !path.isAbsolute(parsed.logoPath)) {
        parsed.logoPath = path.resolve(themeDir, parsed.logoPath)
    }

    return { ...DEFAULT_THEME, ...parsed }
}

export function mergeThemeOverrides(base: CdkDiaTheme, overrides: Partial<CdkDiaTheme>): CdkDiaTheme {
    const filtered = Object.fromEntries(
        Object.entries(overrides).filter(([, v]) => v !== undefined && v !== null && v !== '')
    ) as Partial<CdkDiaTheme>
    return { ...base, ...filtered }
}
