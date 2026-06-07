import Values from "values.js"

export class ColorPalette {

    static byInd(num: number, baseColor: string = '#F3F3F3'): string {
        const color = new Values(baseColor)
        const shade = color.shade(6 * num)
        return shade.hexString()
    }
}
