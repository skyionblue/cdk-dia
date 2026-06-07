import * as fs from 'fs'
import * as util from 'util'
import * as hasbin from 'hasbin'
import {toDot} from "ts-graphviz"
import childProcess from "child_process"
import chalk from "chalk"
import terminalLink from "terminal-link"

const sanitizeFilename = require('sanitize-filename')
const exec = util.promisify(childProcess.exec)

import * as diagram from "../../diagram"
import {DiagramRenderer, RenderingOutput, RenderingProps, RenderingError} from "../diagram-renderer"
import {GraphvizGenerator} from "./GraphvizGenerator"
import {PostProcessor} from "../../brand/post-processor"
import * as path from "path"
import {RootGraphModel} from "ts-graphviz"

export class GraphvizRenderingProps extends RenderingProps {
    diagram: diagram.Diagram
    path: string
}

export class GraphvizRenderingOutput implements RenderingOutput {

    constructor(private imagePath: string, private imageType: string) {}

    userOutput(): void {
        if (terminalLink.isSupported)
            console.log(chalk.green(`CDK code diagram generated to ${this.imageType.toUpperCase()} at ${chalk.bold(terminalLink(this.imagePath, this.imagePath))}`))
        else
            console.log(chalk.green(`CDK code diagram generated to ${this.imageType.toUpperCase()} at ${chalk.bold(this.imagePath)}`))

    }
}

export class Graphviz implements DiagramRenderer {

    /*
     *  renders a `diagram.Diagram` to a png
     */
    async render(props: GraphvizRenderingProps): Promise<GraphvizRenderingOutput> {

        const basePath = props.path.replace(/\.[^/.]+$/, "")
        const targetDotPath = `${basePath}.dot`
        const targetPngPath = `${basePath}.png`

        fs.mkdirSync(path.dirname(path.resolve(targetPngPath)), { recursive: true })

        this.renderToDot(props.diagram, targetDotPath, props.theme)
        await Graphviz.generatePng(targetDotPath, targetPngPath)

        if (props.theme) {
            await PostProcessor.apply(targetPngPath, props.theme)
        }

        return new GraphvizRenderingOutput(targetPngPath, "png")
    }

    /*
     *  renders a `diagram.Diagram` to a dot file
     */
    renderToDot(dia: diagram.Diagram, targetDotPath: string, theme?: import('../../brand/theme').CdkDiaTheme): void {

        const graphRoot = new GraphvizGenerator().generate(dia, theme)

        // generate Dot representation
        const dot = toDot(graphRoot)

        // save Dot to file
        fs.writeFileSync(targetDotPath, dot)
    }

    private static async generatePng(dotPath: string, targetPngPath: string): Promise<void> {

        try {
            await Graphviz.dotToPng(dotPath, targetPngPath)
        } catch (e) {

            if (!hasbin.sync(Graphviz.GRAPHVIZ_BINARY)) {
                throw new RenderingError("Graphvig '" + Graphviz.GRAPHVIZ_BINARY + "' binary does not exist locally or in PATH", [], [
                    "Install Graphviz and make sure it is available in PATH",
                    "Using brew: 'brew install graphviz'"])
            } else {
                if (e instanceof RenderingError) {
                    throw e
                } else {
                    throw new RenderingError(e.message)
                }
            }
        }
    }

    private static sanitizeAndResolvePath(dirty: string): string {
        return path.resolve(dirty.split(path.sep).map(it => {
            return sanitizeFilename(it)
        }).join(path.sep))
    }

    private static async dotToPng(sourceDotFile: string, targetPngFile: string) {

        const cmdParts = [
            Graphviz.GRAPHVIZ_BINARY,
            Graphviz.sanitizeAndResolvePath(sourceDotFile),
            `-T png`,
            `>`,
            Graphviz.sanitizeAndResolvePath(targetPngFile)
        ]

        const {stdout, stderr} = await exec(cmdParts.join(" "))

        const fileExists = fs.existsSync(targetPngFile)
        if (!fileExists) {
            throw new RenderingError("Failed to generate PNG: file does not exist.")
        }

        const stats = fs.lstatSync(targetPngFile)
        if (stats.size < 2) {
            throw new RenderingError("Generated PNG doesn't seem valid: file size is too small.",
                [stdout, stderr],
                [". make sure Graphviz is installed and available in the PATH"])
        }
    }

    /**
     * Renders a pre-built ts-graphviz RootGraphModel to PNG (used by topology renderer).
     */
    static async renderGraphModel(
        model: RootGraphModel,
        targetPngPath: string,
        theme?: import('../../brand/theme').CdkDiaTheme,
    ): Promise<GraphvizRenderingOutput> {
        const basePath = targetPngPath.replace(/\.[^/.]+$/, "")
        const dotPath = `${basePath}.dot`

        fs.mkdirSync(path.dirname(path.resolve(targetPngPath)), { recursive: true })

        const dot = toDot(model)
        fs.writeFileSync(dotPath, dot)

        await Graphviz.generatePng(dotPath, targetPngPath)

        if (theme) {
            await PostProcessor.apply(targetPngPath, theme)
        }

        return new GraphvizRenderingOutput(targetPngPath, 'png')
    }

    private static GRAPHVIZ_BINARY = "dot"
}

