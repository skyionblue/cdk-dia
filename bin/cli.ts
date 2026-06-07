#!/usr/bin/env node
import chalk from "chalk"
import yargs from "yargs/yargs"
import * as path from "path"
import * as fs from "fs"
import {CdkDia, Renderers} from "../src/cdk-dia"
import * as rendering from "../src/render/index"
import {loadTheme, mergeThemeOverrides} from "../src/brand/theme-loader"
import {CdkDiaTheme} from "../src/brand/theme"

async function initCli(): Promise<cdkDiaCliArgs> {

    return yargs(process.argv.slice(2)).options({
        'cdk-tree-path': {type: 'string', alias: 'tree', default: 'cdk.out/tree.json', describe: 'Path of synthesized CDK cloud assembly'},
        'target-path': {type: 'string', alias: 'target', default: 'diagrams/diagram.png', describe: 'Target path for rendered PNG'},
        'collapse': {type: 'boolean', default: true, describe: 'Collapse CDK constructs'},
        'collapse-double-clusters': {type: 'boolean', default: true, describe: 'Collapse CDK constructs with one child that is a cluster itself'},
        'include': {type: 'array', describe: 'Stacks to include (if not specified all stacks are diagramed)', alias: 'stacks'},
        'exclude': {type: 'array', describe: 'Stacks to exclude'},
        'rendering': {type: 'string', choices: [Renderers.GRAPHVIZ, Renderers.CYTOSCAPE], default: Renderers.GRAPHVIZ, describe: 'The rendering engine to use'},
        'theme': {type: 'string', describe: 'Path to a JSON theme config file for branding'},
        'logo': {type: 'string', describe: 'Path to a logo image (PNG) to overlay on the diagram'},
        'title': {type: 'string', describe: 'Title text to render at the top of the diagram'},
        'footer': {type: 'string', describe: 'Footer text to render at the bottom of the diagram'},
        'per-stack': {type: 'boolean', default: false, describe: 'Generate a separate diagram for each stack, saved as diagrams/<StackName>.png'},
        'per-env': {type: 'boolean', default: false, describe: 'Generate one diagram per environment group defined in the theme\'s "environments" field'},
        'topology': {type: 'boolean', default: false, describe: 'Render using AWS topology mode: VPC boundary with Public/Private/Isolated subnet zones'},
    }).version(false).argv
}

function resolveTheme(args: cdkDiaCliArgs, titleOverride?: string): CdkDiaTheme | undefined {
    let theme: CdkDiaTheme | undefined

    if (args.theme) {
        theme = loadTheme(args.theme)
    }

    const overrides: Partial<CdkDiaTheme> = {
        logoPath: args.logo,
        title: titleOverride ?? args.title,
        footer: args.footer,
        topology: args.topology || undefined,
    }

    const hasOverrides = Object.values(overrides).some(v => v !== undefined)

    if (theme) {
        return mergeThemeOverrides(theme, overrides)
    } else if (hasOverrides) {
        return mergeThemeOverrides({}, overrides)
    }

    return undefined
}

function resolveStackNames(treeJsonPath: string, exclude: string[] | undefined): string[] {
    const resolvedPath = path.isAbsolute(treeJsonPath)
        ? treeJsonPath
        : path.join(process.cwd(), treeJsonPath)
    const raw = JSON.parse(fs.readFileSync(resolvedPath, 'utf-8'))
    const METADATA_NODES = new Set(['Tree'])
    const names = Object.keys(raw?.tree?.children ?? {}).filter(k => !METADATA_NODES.has(k))
    if (exclude && exclude.length > 0) {
        return names.filter(n => !exclude.includes(n))
    }
    return names
}

async function generateDiagram(args: cdkDiaCliArgs) {

    const cdkDia = new CdkDia()
    const packageBasePath = path.dirname(require.resolve('../../package.json'))
    const outputDir = path.dirname(args['target-path'])

    if (args['per-env']) {
        const baseTheme = resolveTheme(args)
        const environments = baseTheme?.environments
        if (!environments || environments.length === 0) {
            console.error(chalk.red('--per-env requires an "environments" array in your theme JSON.'))
            process.exit(1)
        }
        console.log(chalk.cyan(`Generating ${environments.length} environment diagram(s) into ${outputDir}/`))
        for (const env of environments) {
            const envTitle = env.title ?? env.name
            const targetPath = path.join(outputDir, `${env.name}.png`)
            const theme = resolveTheme(args, envTitle)
            await cdkDia.generateDiagram(
                args['cdk-tree-path'], targetPath, args.collapse, args['collapse-double-clusters'],
                packageBasePath, env.stacks, undefined, args['rendering'], theme
            ).then(output => output.userOutput())
              .catch(e => console.warn(chalk.yellow(`  Skipped ${env.name}: ${e.message}`)))
        }
        return
    }

    if (args['per-stack']) {
        const excludedStacks = args.exclude?.map(it => it.toString())
        const stacks = resolveStackNames(args['cdk-tree-path'], excludedStacks)
        console.log(chalk.cyan(`Generating ${stacks.length} per-stack diagram(s) into ${outputDir}/`))
        for (const stackName of stacks) {
            const targetPath = path.join(outputDir, `${stackName}.png`)
            const theme = resolveTheme(args, args.title ?? stackName)
            await cdkDia.generateDiagram(
                args['cdk-tree-path'], targetPath, args.collapse, args['collapse-double-clusters'],
                packageBasePath, [stackName], undefined, args['rendering'], theme
            ).then(output => output.userOutput())
              .catch(e => console.warn(chalk.yellow(`  Skipped ${stackName}: ${e.message}`)))
        }
        return
    }

    let includedStacks: string[] | false = false
    if (args.include !== undefined) {
        includedStacks = args.include.map(it => it.toString())
    }

    let excludedStacks: string[] | undefined = undefined
    if (args.exclude !== undefined) {
        excludedStacks = args.exclude.map(it => it.toString())
    }

    const theme = resolveTheme(args)

    cdkDia.generateDiagram(args["cdk-tree-path"], args["target-path"], args.collapse, args["collapse-double-clusters"], packageBasePath, includedStacks, excludedStacks, args["rendering"], theme)
        .then((output) => output.userOutput())
        .catch(e => {
            console.error(`Failed to generate diagram - ${e}`)
            throw e
        })
}

function printError(e) {
    if (e instanceof rendering.RenderingError) {
        notifyRenderingError(e)
    } else {
        notifyRenderingError(new rendering.RenderingError(`Unexpected error occurred: ${e.message}`))
    }
}

function notifyRenderingError(e: rendering.RenderingError) {
    console.log(`${chalk.red.bold(`Failed to render diagram: ${e.message}`)}`)

    if (e.fixTips.length > 0)
        console.log(`${chalk.underline(`What could you try?`)}`)

    e.fixTips.forEach(tip => {
        console.log(`\t${tip}`)
    })
}

initCli()
    .then(args => {
        generateDiagram(args)
            .catch(printError)
    })
    .catch(printError)

interface cdkDiaCliArgs {
    'cdk-tree-path': string,
    'target-path': string,
    collapse: boolean,
    'collapse-double-clusters': boolean,
    include: (string | number)[] | undefined,
    exclude: (string | number)[] | undefined,
    rendering: Renderers,
    theme: string | undefined,
    logo: string | undefined,
    title: string | undefined,
    footer: string | undefined,
    'per-stack': boolean,
    'per-env': boolean,
    'topology': boolean,
}
